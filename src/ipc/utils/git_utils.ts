import { getGitAuthor } from "./git_author";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { exec } from "dugite";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import pathModule from "node:path";
import { readSettings } from "../../main/settings";
import log from "electron-log";
const logger = log.scope("git_utils");
import type {
  GitBaseParams,
  GitFileParams,
  GitCheckoutParams,
  GitBranchRenameParams,
  GitCloneParams,
  GitCommitParams,
  GitLogParams,
  GitFileAtCommitParams,
  GitSetRemoteUrlParams,
  GitStageToRevertParams,
  GitInitParams,
  GitPushParams,
  GitCommit,
} from "../git_types";
import type { GitDiffFile, GitDiffResult } from "../ipc_types";

/**
 * Helper function that wraps exec and throws an error if the exit code is non-zero
 */
async function execOrThrow(
  args: string[],
  path: string,
  errorMessage?: string,
): Promise<void> {
  const result = await exec(args, path);
  if (result.exitCode !== 0) {
    const errorDetails = result.stderr.trim() || result.stdout.trim();
    const error = errorMessage
      ? `${errorMessage}. ${errorDetails}`
      : `Git command failed: ${args.join(" ")}. ${errorDetails}`;
    throw new Error(error);
  }
}

export async function getCurrentCommitHash({
  path,
  ref = "HEAD",
}: GitInitParams): Promise<string> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    const result = await exec(["rev-parse", ref], path);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to resolve ref '${ref}': ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout.trim();
  } else {
    return await git.resolveRef({
      fs,
      dir: path,
      ref,
    });
  }
}

export async function isGitStatusClean({
  path,
}: {
  path: string;
}): Promise<boolean> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    const result = await exec(["status", "--porcelain"], path);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to get status: ${result.stderr}`);
    }

    // If output is empty, working directory is clean (no changes)
    const isClean = result.stdout.trim().length === 0;
    return isClean;
  } else {
    const statusMatrix = await git.statusMatrix({ fs, dir: path });
    return statusMatrix.every(
      (row) => row[1] === 1 && row[2] === 1 && row[3] === 1,
    );
  }
}

export async function gitCommit({
  path,
  message,
  amend,
}: GitCommitParams): Promise<string> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    // Get author info to match isomorphic-git behavior
    const author = await getGitAuthor();
    // Perform the commit using dugite with --author flag
    const args = [
      "commit",
      "-m",
      message,
      "--author",
      `${author.name} <${author.email}>`,
    ];
    if (amend) {
      args.push("--amend");
    }
    await execOrThrow(args, path, "Failed to create commit");
    // Get the new commit hash
    const result = await exec(["rev-parse", "HEAD"], path);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to get commit hash: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout.trim();
  } else {
    return git.commit({
      fs: fs,
      dir: path,
      message,
      author: await getGitAuthor(),
      amend: amend,
    });
  }
}

export async function gitCheckout({
  path,
  ref,
}: GitCheckoutParams): Promise<void> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    await execOrThrow(
      ["checkout", ref],
      path,
      `Failed to checkout ref '${ref}'`,
    );
    return;
  } else {
    return git.checkout({ fs, dir: path, ref });
  }
}

export async function gitStageToRevert({
  path,
  targetOid,
}: GitStageToRevertParams): Promise<void> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    // Get the current HEAD commit hash
    const currentHeadResult = await exec(["rev-parse", "HEAD"], path);
    if (currentHeadResult.exitCode !== 0) {
      throw new Error(
        `Failed to get current commit: ${currentHeadResult.stderr.trim() || currentHeadResult.stdout.trim()}`,
      );
    }

    const currentCommit = currentHeadResult.stdout.trim();

    // If we're already at the target commit, nothing to do
    if (currentCommit === targetOid) {
      return;
    }

    // Safety: refuse to run if the work-tree isn't clean.
    const statusResult = await exec(["status", "--porcelain"], path);
    if (statusResult.exitCode !== 0) {
      throw new Error(
        `Failed to get status: ${statusResult.stderr.trim() || statusResult.stdout.trim()}`,
      );
    }
    if (statusResult.stdout.trim() !== "") {
      throw new Error("Cannot revert: working tree has uncommitted changes.");
    }

    // Reset the working directory and index to match the target commit state
    // This effectively undoes all changes since the target commit
    await execOrThrow(
      ["reset", "--hard", targetOid],
      path,
      `Failed to reset to target commit '${targetOid}'`,
    );

    // Reset back to the original HEAD but keep the working directory as it is
    // This stages all the changes needed to revert to the target state
    await execOrThrow(
      ["reset", "--soft", currentCommit],
      path,
      "Failed to reset back to original HEAD",
    );
  } else {
    // Get status matrix comparing the target commit (previousVersionId as HEAD) with current working directory
    const matrix = await git.statusMatrix({
      fs,
      dir: path,
      ref: targetOid,
    });

    // Process each file to revert to the state in previousVersionId
    for (const [filepath, headStatus, workdirStatus] of matrix) {
      const fullPath = pathModule.join(path, filepath);

      // If file exists in HEAD (previous version)
      if (headStatus === 1) {
        // If file doesn't exist or has changed in working directory, restore it from the target commit
        if (workdirStatus !== 1) {
          const { blob } = await git.readBlob({
            fs,
            dir: path,
            oid: targetOid,
            filepath,
          });
          await fsPromises.mkdir(pathModule.dirname(fullPath), {
            recursive: true,
          });
          await fsPromises.writeFile(fullPath, Buffer.from(blob));
        }
      }
      // If file doesn't exist in HEAD but exists in working directory, delete it
      else if (headStatus === 0 && workdirStatus !== 0) {
        if (fs.existsSync(fullPath)) {
          await fsPromises.unlink(fullPath);
          await git.remove({
            fs,
            dir: path,
            filepath: filepath,
          });
        }
      }
    }

    // Stage all changes
    await git.add({
      fs,
      dir: path,
      filepath: ".",
    });
  }
}

export async function gitAddAll({ path }: GitBaseParams): Promise<void> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    await execOrThrow(["add", "."], path, "Failed to stage all files");
    return;
  } else {
    return git.add({ fs, dir: path, filepath: "." });
  }
}

export async function gitAdd({ path, filepath }: GitFileParams): Promise<void> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    await execOrThrow(
      ["add", "--", filepath],
      path,
      `Failed to stage file '${filepath}'`,
    );
  } else {
    await git.add({
      fs,
      dir: path,
      filepath,
    });
  }
}

export async function gitInit({
  path,
  ref = "main",
}: GitInitParams): Promise<void> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    await execOrThrow(
      ["init", "-b", ref],
      path,
      `Failed to initialize git repository with branch '${ref}'`,
    );
  } else {
    await git.init({
      fs,
      dir: path,
      defaultBranch: ref,
    });
  }
}

export async function gitRemove({
  path,
  filepath,
}: GitFileParams): Promise<void> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    await execOrThrow(
      ["rm", "-f", "--", filepath],
      path,
      `Failed to remove file '${filepath}'`,
    );
  } else {
    await git.remove({
      fs,
      dir: path,
      filepath,
    });
  }
}

export async function getGitUncommittedFiles({
  path,
}: GitBaseParams): Promise<string[]> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    const result = await exec(["status", "--porcelain"], path);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to get uncommitted files: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result.stdout
      .toString()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3).trim());
  } else {
    const statusMatrix = await git.statusMatrix({ fs, dir: path });
    return statusMatrix
      .filter((row) => row[1] !== 1 || row[2] !== 1 || row[3] !== 1)
      .map((row) => row[0]);
  }
}

export async function getFileAtCommit({
  path,
  filePath,
  commitHash,
}: GitFileAtCommitParams): Promise<string | null> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    try {
      const result = await exec(["show", `${commitHash}:${filePath}`], path);
      if (result.exitCode !== 0) {
        // File doesn't exist at this commit or other error
        return null;
      }
      return result.stdout;
    } catch (error: any) {
      logger.error(
        `Error getting file at commit ${commitHash}: ${error.message}`,
      );
      // File doesn't exist at this commit
      return null;
    }
  } else {
    try {
      const { blob } = await git.readBlob({
        fs,
        dir: path,
        oid: commitHash,
        filepath: filePath,
      });
      return Buffer.from(blob).toString("utf-8");
    } catch (error: any) {
      logger.error(
        `Error getting file at commit ${commitHash}: ${error.message}`,
      );
      // File doesn't exist at this commit
      return null;
    }
  }
}

export async function gitListBranches({
  path,
}: GitBaseParams): Promise<string[]> {
  const settings = readSettings();

  if (settings.enableNativeGit) {
    const result = await exec(["branch", "--list"], path);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
    // Parse output:
    // e.g. "* main\n  feature/login"
    return result.stdout
      .toString()
      .split("\n")
      .map((line) => line.replace("*", "").trim())
      .filter((line) => line.length > 0);
  } else {
    return await git.listBranches({
      fs,
      dir: path,
    });
  }
}

export async function gitRenameBranch({
  path,
  oldBranch,
  newBranch,
}: GitBranchRenameParams): Promise<void> {
  const settings = readSettings();

  if (settings.enableNativeGit) {
    // git branch -m oldBranch newBranch
    const result = await exec(["branch", "-m", oldBranch, newBranch], path);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
  } else {
    await git.renameBranch({
      fs,
      dir: path,
      oldref: oldBranch,
      ref: newBranch,
    });
  }
}

export async function gitClone({
  path,
  url,
  accessToken,
  singleBranch = true,
  depth,
}: GitCloneParams): Promise<void> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    // Dugite version (real Git)
    // Build authenticated URL if accessToken is provided and URL doesn't already have auth
    const finalUrl =
      accessToken && !url.includes("@")
        ? url.replace("https://", `https://${accessToken}:x-oauth-basic@`)
        : url;
    const args = ["clone"];
    if (depth && depth > 0) {
      args.push("--depth", String(depth));
    }
    if (singleBranch) {
      args.push("--single-branch");
    }
    args.push(finalUrl, path);
    const result = await exec(args, ".");

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString());
    }
  } else {
    // isomorphic-git version
    // Strip any embedded auth from URL since isomorphic-git uses onAuth
    const cleanUrl = url.replace(/https:\/\/[^@]+@/, "https://");
    await git.clone({
      fs,
      http,
      dir: path,
      url: cleanUrl,
      onAuth: accessToken
        ? () => ({
            username: accessToken,
            password: "x-oauth-basic",
          })
        : undefined,
      singleBranch,
      depth: depth ?? undefined,
    });
  }
}

export async function gitSetRemoteUrl({
  path,
  remoteUrl,
}: GitSetRemoteUrlParams): Promise<void> {
  const settings = readSettings();

  if (settings.enableNativeGit) {
    // Dugite version
    try {
      // Try to add the remote
      const result = await exec(["remote", "add", "origin", remoteUrl], path);

      // If remote already exists, update it instead
      if (result.exitCode !== 0 && result.stderr.includes("already exists")) {
        const updateResult = await exec(
          ["remote", "set-url", "origin", remoteUrl],
          path,
        );

        if (updateResult.exitCode !== 0) {
          throw new Error(`Failed to update remote: ${updateResult.stderr}`);
        }
      } else if (result.exitCode !== 0) {
        // Handle other errors
        throw new Error(`Failed to add remote: ${result.stderr}`);
      }
    } catch (error: any) {
      logger.error("Error setting up remote:", error);
      throw error; // or handle as needed
    }
  } else {
    //isomorphic-git version
    await git.setConfig({
      fs,
      dir: path,
      path: "remote.origin.url",
      value: remoteUrl,
    });
  }
}

export async function gitPush({
  path,
  branch,
  accessToken,
  force,
}: GitPushParams): Promise<void> {
  const settings = readSettings();

  if (settings.enableNativeGit) {
    // Dugite version
    try {
      // Push using the configured origin remote (which already has auth in URL)
      const args = ["push", "origin", `main:${branch}`];
      if (force) {
        args.push("--force");
      }
      const result = await exec(args, path);

      if (result.exitCode !== 0) {
        const errorMsg = result.stderr.toString() || result.stdout.toString();
        throw new Error(`Git push failed: ${errorMsg}`);
      }
    } catch (error: any) {
      logger.error("Error during git push:", error);
      throw new Error(`Git push failed: ${error.message}`);
    }
  } else {
    // isomorphic-git version
    await git.push({
      fs,
      http,
      dir: path,
      remote: "origin",
      ref: "main",
      remoteRef: branch,
      onAuth: () => ({
        username: accessToken,
        password: "x-oauth-basic",
      }),
      force: !!force,
    });
  }
}

export async function gitCurrentBranch({
  path,
}: GitBaseParams): Promise<string | null> {
  const settings = readSettings();
  if (settings.enableNativeGit) {
    // Dugite version
    const result = await exec(["branch", "--show-current"], path);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to get current branch: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const branch = result.stdout.trim() || null;
    return branch;
  } else {
    // isomorphic-git version returns string | undefined
    const branch = await git.currentBranch({
      fs,
      dir: path,
      fullname: false,
    });
    return branch ?? null;
  }
}

export async function gitLog({
  path,
  depth = 100_000,
}: GitLogParams): Promise<GitCommit[]> {
  const settings = readSettings();

  if (settings.enableNativeGit) {
    return await gitLogNative(path, depth);
  } else {
    // isomorphic-git fallback: this already returns the same structure
    return await git.log({
      fs,
      dir: path,
      depth,
    });
  }
}

export async function gitIsIgnored({
  path,
  filepath,
}: GitFileParams): Promise<boolean> {
  const settings = readSettings();

  if (settings.enableNativeGit) {
    // Dugite version
    // git check-ignore file
    const result = await exec(["check-ignore", filepath], path);

    // If exitCode == 0 → file is ignored
    if (result.exitCode === 0) return true;

    // If exitCode == 1 → not ignored
    if (result.exitCode === 1) return false;

    // Other exit codes are actual errors
    throw new Error(result.stderr.toString());
  } else {
    // isomorphic-git version
    return await git.isIgnored({
      fs,
      dir: path,
      filepath,
    });
  }
}

export async function gitLogNative(
  path: string,
  depth = 100_000,
): Promise<GitCommit[]> {
  // Use git log with custom format to get all data in a single process
  // Format: %H = commit hash, %at = author timestamp (unix), %B = raw body (message)
  // Using null byte as field separator and custom delimiter between commits
  const logArgs = [
    "log",
    "--max-count",
    String(depth),
    "--format=%H%x00%at%x00%B%x00---END-COMMIT---",
    "HEAD",
  ];

  const logResult = await exec(logArgs, path);

  if (logResult.exitCode !== 0) {
    throw new Error(logResult.stderr.toString());
  }

  const output = logResult.stdout.toString().trim();
  if (!output) {
    return [];
  }

  // Split by commit delimiter (without newline since trim() removes trailing newline)
  const commitChunks = output.split("\x00---END-COMMIT---").filter(Boolean);
  const entries: GitCommit[] = [];

  for (const chunk of commitChunks) {
    // Split by null byte: [oid, timestamp, message]
    const parts = chunk.split("\x00");
    if (parts.length >= 3) {
      const oid = parts[0].trim();
      const timestamp = Number(parts[1]);
      // Message is everything after the second null byte, may contain null bytes itself
      const message = parts.slice(2).join("\x00");

      entries.push({
        oid,
        commit: {
          message: message,
          author: {
            timestamp: timestamp,
          },
        },
      });
    }
  }

  return entries;
}

export type { GitDiffFile, GitDiffResult } from "../ipc_types";

function mapDiffStatus(code: string): GitDiffFile["status"] {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  return "modified";
}

/**
 * Return the diff introduced by a single commit (vs its first parent), or the
 * diff between two arbitrary commits when `fromOid` is provided.
 *
 * Uses native git via dugite. The root commit (no parent) is diffed against the
 * empty tree so its full contents show as additions.
 */
export async function gitDiffNative({
  path,
  toOid,
  fromOid,
}: {
  path: string;
  toOid: string;
  fromOid?: string;
}): Promise<GitDiffResult> {
  // Resolve the base revision. When not supplied, diff against the commit's
  // first parent; fall back to the empty-tree hash for the root commit.
  let base = fromOid;
  if (!base) {
    const parentResult = await exec(
      ["rev-parse", "--verify", "--quiet", `${toOid}^`],
      path,
    );
    base =
      parentResult.exitCode === 0
        ? parentResult.stdout.toString().trim()
        : // Git's well-known empty tree object hash.
          "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  }

  const range = [base, toOid];

  // Numstat for per-file insertion/deletion counts + rename detection.
  const numstatResult = await exec(
    ["diff", "--numstat", "--find-renames", ...range],
    path,
  );
  if (numstatResult.exitCode !== 0) {
    throw new Error(
      `git diff --numstat failed: ${numstatResult.stderr.toString()}`,
    );
  }

  // Name-status for add/modify/delete/rename classification.
  const nameStatusResult = await exec(
    ["diff", "--name-status", "--find-renames", ...range],
    path,
  );
  if (nameStatusResult.exitCode !== 0) {
    throw new Error(
      `git diff --name-status failed: ${nameStatusResult.stderr.toString()}`,
    );
  }

  // Full unified patch text.
  const patchResult = await exec(["diff", "--find-renames", ...range], path);
  if (patchResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${patchResult.stderr.toString()}`);
  }

  // Parse name-status into a path -> status map.
  const statusByPath = new Map<string, GitDiffFile["status"]>();
  const renameOldPath = new Map<string, string>();
  for (const line of nameStatusResult.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const cols = line.split("\t");
    const code = cols[0];
    if (code.startsWith("R") && cols.length >= 3) {
      statusByPath.set(cols[2], "renamed");
      renameOldPath.set(cols[2], cols[1]);
    } else if (cols.length >= 2) {
      statusByPath.set(cols[1], mapDiffStatus(code));
    }
  }

  const files: GitDiffFile[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const line of numstatResult.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const [insStr, delStr] = cols;
    // For renames, numstat path column can be "old => new"; prefer the last col.
    const filePath = cols[cols.length - 1];
    const binary = insStr === "-" || delStr === "-";
    const insertions = binary ? 0 : Number(insStr) || 0;
    const deletions = binary ? 0 : Number(delStr) || 0;
    totalInsertions += insertions;
    totalDeletions += deletions;
    files.push({
      path: filePath,
      oldPath: renameOldPath.get(filePath),
      status: statusByPath.get(filePath) ?? "modified",
      insertions,
      deletions,
      binary,
    });
  }

  return {
    patch: patchResult.stdout.toString(),
    files,
    insertions: totalInsertions,
    deletions: totalDeletions,
  };
}
