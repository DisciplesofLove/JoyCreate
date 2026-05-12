/**
 * Radicle CLI wrapper.
 *
 * Wraps the `rad` Heartwood binary spawned as a sidecar service.
 * All process invocations throw on non-zero exit so IPC handlers can surface
 * structured errors per `ipc-handlers.instructions.md`.
 */

import { execFile, ExecFileException } from "child_process";
import { promisify } from "util";
import path from "node:path";
import fs from "fs-extra";
import log from "electron-log";
import {
  resolveRadicleBinary,
  getRadicleHomePath,
} from "@/ipc/handlers/services_handlers";

const exec = promisify(execFile);
const logger = log.scope("radicle_client");

export interface RadicleSelf {
  nid: string; // node id (z6Mk... did:key style)
  alias?: string;
  did: string; // did:key:<nid>
}

export interface RadicleRepoSummary {
  rid: string; // rad:z3...
  name: string;
  description?: string;
  defaultBranch?: string;
  head?: string; // commit hash
  visibility?: "public" | "private";
}

export interface RadicleNodeStatus {
  running: boolean;
  nid?: string;
  peers?: number;
  listenAddrs?: string[];
}

function radBin(): string {
  const bin = resolveRadicleBinary();
  if (!bin) {
    throw new Error(
      "Radicle CLI (`rad`) not found. Install from https://radicle.xyz."
    );
  }
  return bin;
}

function radEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RAD_HOME: getRadicleHomePath(),
    ...extra,
  };
}

async function runRad(
  args: string[],
  opts: { cwd?: string; passphrase?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  const bin = radBin();
  const env = radEnv(
    opts.passphrase ? { RAD_PASSPHRASE: opts.passphrase } : undefined
  );
  try {
    const result = await exec(bin, args, {
      env,
      cwd: opts.cwd,
      timeout: opts.timeout ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch (e) {
    const err = e as ExecFileException & { stdout?: string; stderr?: string };
    const stderr = (err.stderr ?? "").toString().trim();
    const stdout = (err.stdout ?? "").toString().trim();
    const msg = stderr || stdout || err.message;
    logger.error(`rad ${args.join(" ")} failed: ${msg}`);
    throw new Error(`rad ${args[0]} failed: ${msg}`);
  }
}

// =============================================================================
// IDENTITY
// =============================================================================

/**
 * Create (or import) a Radicle identity. Spawns `rad auth` non-interactively
 * with the supplied alias and passphrase. Returns the resulting NID.
 *
 * Throws on failure (e.g., identity already exists).
 */
export async function createIdentity(params: {
  alias: string;
  passphrase: string;
}): Promise<RadicleSelf> {
  const radHome = getRadicleHomePath();
  await fs.ensureDir(radHome);

  // `rad auth --alias <name>` creates a new identity. Passphrase is read from
  // RAD_PASSPHRASE; --stdin is also valid but RAD_PASSPHRASE is simpler.
  await runRad(["auth", "--alias", params.alias], {
    passphrase: params.passphrase,
  });

  return getSelf();
}

/**
 * Read the currently active Radicle identity. Throws if none exists yet.
 */
export async function getSelf(): Promise<RadicleSelf> {
  const { stdout } = await runRad(["self"]);
  // `rad self` output (heartwood ≥ 1.0):
  //   DID  did:key:z6Mk...
  //   Node ID  z6Mk...
  //   Alias  jane
  const lines = stdout.split(/\r?\n/);
  const did = pickField(lines, "DID") ?? "";
  const nid = pickField(lines, "Node ID") ?? did.replace("did:key:", "");
  const alias = pickField(lines, "Alias") ?? undefined;
  if (!nid) throw new Error(`Could not parse 'rad self' output:\n${stdout}`);
  return { nid, did: did || `did:key:${nid}`, alias };
}

/**
 * Returns true if an identity exists in RAD_HOME (no passphrase needed).
 */
export async function hasIdentity(): Promise<boolean> {
  const radHome = getRadicleHomePath();
  return fs.pathExists(path.join(radHome, "keys", "radicle"));
}

// =============================================================================
// NODE
// =============================================================================

/**
 * `rad node status` parsed into a structured object. Returns running=false on
 * any error rather than throwing — used by readiness probes.
 */
export async function nodeStatus(): Promise<RadicleNodeStatus> {
  try {
    const { stdout } = await runRad(["node", "status"], { timeout: 10_000 });
    const running = /running/i.test(stdout);
    const peerMatch = stdout.match(/(\d+)\s+peers?/i);
    return {
      running,
      peers: peerMatch ? Number(peerMatch[1]) : undefined,
    };
  } catch {
    return { running: false };
  }
}

// =============================================================================
// REPOSITORIES
// =============================================================================

/**
 * Initialize the working directory at `cwd` as a Radicle repo and push to the
 * local node. Returns the new RID.
 *
 * `cwd` MUST already be a git repo (run `git init` + at least one commit first).
 */
export async function initRepo(params: {
  cwd: string;
  name: string;
  description: string;
  defaultBranch?: string;
  visibility?: "public" | "private";
  passphrase: string;
}): Promise<{ rid: string }> {
  const branch = params.defaultBranch ?? "main";
  const visArg = params.visibility === "private" ? ["--private"] : ["--public"];

  const { stdout } = await runRad(
    [
      "init",
      "--name",
      params.name,
      "--description",
      params.description,
      "--default-branch",
      branch,
      "--no-confirm",
      ...visArg,
    ],
    { cwd: params.cwd, passphrase: params.passphrase, timeout: 120_000 }
  );

  const rid = extractRid(stdout);
  if (!rid) throw new Error(`Could not parse RID from 'rad init':\n${stdout}`);
  return { rid };
}

/**
 * Push the current branch to the Radicle node and seed it across the network.
 */
export async function pushRepo(params: {
  cwd: string;
  passphrase: string;
}): Promise<void> {
  await runRad(["push"], {
    cwd: params.cwd,
    passphrase: params.passphrase,
    timeout: 120_000,
  });
}

/**
 * Clone a Radicle repo by RID into `targetDir` (which must not yet exist).
 */
export async function cloneRepo(params: {
  rid: string;
  targetDir: string;
  passphrase?: string;
}): Promise<void> {
  await fs.ensureDir(path.dirname(params.targetDir));
  if (await fs.pathExists(params.targetDir)) {
    throw new Error(`Target directory already exists: ${params.targetDir}`);
  }
  await runRad(["clone", params.rid, params.targetDir, "--no-confirm"], {
    passphrase: params.passphrase,
    timeout: 180_000,
  });
}

/**
 * Pull updates for the repo at `cwd` from peers via the local node.
 */
export async function syncRepo(params: {
  cwd: string;
  passphrase?: string;
}): Promise<void> {
  await runRad(["sync"], {
    cwd: params.cwd,
    passphrase: params.passphrase,
    timeout: 120_000,
  });
}

/**
 * List repositories seeded by the local node.
 */
export async function listRepos(): Promise<RadicleRepoSummary[]> {
  const { stdout } = await runRad(["ls", "--json"]).catch(async () => {
    // Older versions don't support --json — fall back to plain.
    return runRad(["ls"]);
  });
  return parseRepoList(stdout);
}

/**
 * Return peer NIDs that are currently seeding the given RID, per `rad node sessions`.
 * Best-effort: returns [] if the command fails.
 */
export async function repoPeers(rid: string): Promise<string[]> {
  try {
    const { stdout } = await runRad(["node", "sessions"]);
    // Extract NIDs (z6Mk...) that appear on lines mentioning the RID prefix.
    const ridPrefix = rid.replace(/^rad:/, "").slice(0, 8);
    const peers = new Set<string>();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(ridPrefix)) continue;
      const m = line.match(/(z6Mk[1-9A-HJ-NP-Za-km-z]{40,})/);
      if (m) peers.add(m[1]);
    }
    return Array.from(peers);
  } catch {
    return [];
  }
}

// =============================================================================
// PARSERS
// =============================================================================

function pickField(lines: string[], label: string): string | undefined {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(label.toLowerCase())) {
      // Format: "Label  value" — split on whitespace gap of 2+
      const parts = trimmed.split(/\s{2,}|\t+/);
      if (parts.length >= 2) return parts.slice(1).join(" ").trim();
    }
  }
  return undefined;
}

function extractRid(text: string): string | null {
  const m = text.match(/rad:[A-Za-z0-9]{30,}/);
  return m ? m[0] : null;
}

function parseRepoList(stdout: string): RadicleRepoSummary[] {
  // Try JSON first
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const arr = JSON.parse(trimmed);
      const list = Array.isArray(arr) ? arr : [arr];
      return list.map((r) => ({
        rid: r.rid ?? r.id ?? "",
        name: r.name ?? "",
        description: r.description ?? r.desc ?? undefined,
        defaultBranch: r.defaultBranch ?? r.branch ?? undefined,
        head: r.head ?? undefined,
        visibility: r.visibility ?? undefined,
      }));
    } catch {
      // fall through
    }
  }

  // Plain `rad ls` output: header + rows of [name, RID, head, description...]
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: RadicleRepoSummary[] = [];
  for (const line of lines) {
    const rid = extractRid(line);
    if (!rid) continue;
    const cols = line.split(/\s{2,}|\t+/).map((c) => c.trim());
    out.push({
      rid,
      name: cols[0] ?? rid,
      description: cols.length > 2 ? cols.slice(2).join(" ").trim() : undefined,
    });
  }
  return out;
}

// =============================================================================
// SEED NODES (peer + repo seeding)
// =============================================================================

/**
 * Public Radicle seed nodes. Format: `<NID>@<host>:<port>`.
 * Sourced from https://radicle.network/nodes — keep in sync as the network
 * adds / rotates nodes.
 */
export interface RadicleSeedPreset {
  id: string;
  name: string;
  address: string; // <nid>@<host>:<port>
  description?: string;
  url?: string;
}

export const RADICLE_SEED_PRESETS: RadicleSeedPreset[] = [
  {
    id: "seed.radicle.dev",
    name: "seed.radicle.dev",
    address:
      "z6MksFqXN3Yhqk8pTJdUGLwATkRfQvwZXPqR2qMEhbS9wzpT@seed.radicle.dev:8776",
    description:
      "Official Radicle Foundation seed node (radicle.network/nodes/seed.radicle.dev/).",
    url: "https://radicle.network/nodes/seed.radicle.dev/",
  },
  {
    id: "seed.radicle.xyz",
    name: "seed.radicle.xyz",
    address:
      "z6MksFqXN3Yhqk8pTJdUGLwATkRfQvwZXPqR2qMEhbS9wzpT@seed.radicle.xyz:8776",
    description: "Radicle Foundation seed node (xyz mirror).",
    url: "https://radicle.network/nodes/seed.radicle.xyz/",
  },
  {
    id: "seed.radicle.garden",
    name: "seed.radicle.garden",
    address:
      "z6MkkfM3tPXNPrPevKr3uSiQtHPuwnNhu2yUVjgd2jXVsVz5@seed.radicle.garden:8776",
    description: "Community-run seed node operated by Radicle Garden.",
    url: "https://radicle.network/nodes/seed.radicle.garden/",
  },
  {
    id: "ash-grove.radicle.garden",
    name: "ash-grove.radicle.garden",
    address:
      "z6Mkmqogy2qEM2ummccs7wnoLgmH2hRPpzJaGaeu5MWkZqs5@ash-grove.radicle.garden:8776",
    description: "Community-run seed node (Ash Grove).",
    url: "https://radicle.network/nodes/ash-grove.radicle.garden/",
  },
];

export interface RadicleSeedSession {
  nid: string;
  address?: string;
  status?: string;
  rawLine: string;
}

/**
 * Connect to a peer / seed node. Address format: `<nid>@<host>:<port>`.
 *
 * Wraps `rad node connect <addr>`. Idempotent: re-connecting an existing
 * session is a no-op upstream.
 */
export async function connectSeed(address: string): Promise<void> {
  if (!address.includes("@") || !address.includes(":")) {
    throw new Error(
      `Invalid seed address (expected <nid>@<host>:<port>): ${address}`,
    );
  }
  await runRad(["node", "connect", address], { timeout: 30_000 });
}

/**
 * Disconnect a peer by NID. Wraps `rad node disconnect <nid>`. Best-effort —
 * heartwood throws if the peer wasn't connected; we map that to a no-op.
 */
export async function disconnectSeed(nid: string): Promise<void> {
  if (!/^z6M[1-9A-HJ-NP-Za-km-z]{40,}$/.test(nid)) {
    throw new Error(`Invalid NID: ${nid}`);
  }
  try {
    await runRad(["node", "disconnect", nid], { timeout: 15_000 });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/not connected|unknown peer/i.test(msg)) return;
    throw err;
  }
}

/**
 * List active node sessions (peers + seed nodes the local node is talking to).
 * Each row of `rad node sessions` looks like:
 *   z6Mk...   1.2.3.4:8776   connected   ...
 */
export async function listSeedSessions(): Promise<RadicleSeedSession[]> {
  const { stdout } = await runRad(["node", "sessions"]).catch(() => ({
    stdout: "",
  }));
  const sessions: RadicleSeedSession[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const nidMatch = trimmed.match(/(z6M[1-9A-HJ-NP-Za-km-z]{40,})/);
    if (!nidMatch) continue;
    const cols = trimmed.split(/\s{2,}|\t+/).map((c) => c.trim());
    const addrMatch = trimmed.match(/([\w.-]+:\d{2,5})/);
    const statusMatch = trimmed.match(
      /\b(connected|connecting|disconnected|attempted|failed)\b/i,
    );
    sessions.push({
      nid: nidMatch[1],
      address: addrMatch ? addrMatch[1] : undefined,
      status: statusMatch ? statusMatch[1].toLowerCase() : cols[cols.length - 1],
      rawLine: trimmed,
    });
  }
  return sessions;
}

/**
 * Ask the local node to seed a repo. `scope`:
 *   - `"all"`   → follow all peers' refs (default)
 *   - `"trusted"` → only follow trusted (delegate) refs
 */
export async function seedRepo(params: {
  rid: string;
  scope?: "all" | "trusted";
}): Promise<void> {
  const scope = params.scope ?? "all";
  await runRad(["seed", params.rid, "--scope", scope], { timeout: 30_000 });
}

/** Stop seeding a repo. Wraps `rad unseed <rid>`. */
export async function unseedRepo(rid: string): Promise<void> {
  await runRad(["unseed", rid], { timeout: 30_000 });
}

