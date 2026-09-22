#!/usr/bin/env node
/*
 * Build every distributable for one platform, plus the one-click installer zip.
 *
 *   node scripts/build-installer.mjs win     (run on Windows)
 *   node scripts/build-installer.mjs mac     (run on macOS)
 *   node scripts/build-installer.mjs linux   (run on Linux)
 *
 *   npm run installer            -> host platform
 *   npm run installer:repack     -> host platform, reuse the last `make`
 *
 * Flags:
 *   --skip-build   Reuse existing artifacts instead of running `npm run make`.
 *
 * Output, all in <forge outDir>/installers/:
 *
 *   JoyCreate-Installer-<Platform>-<arch>-<version>.zip   bootstrapper + packages
 *   <every standalone package>                            Setup.exe, .msi, .dmg, .AppImage, .deb, .rpm
 *   SHA256SUMS-<platform>-<arch>.txt                      checksums for all of the above
 *
 * The arch is in the names because macOS is built twice (arm64 and x64) and both
 * builds upload to the same release; without it the second overwrote the first.
 *
 * Set JOYCREATE_REQUIRE_ALL=1 (CI does) to fail when any package is missing —
 * otherwise a runner without WiX would quietly ship a release with no MSI.
 *
 * The web installers (installer/web/) download the zip and refuse to run it
 * unless its hash matches SHA256SUMS.txt, which CI assembles from these files.
 *
 * Artifacts are found by reading Forge's `outDir`. This script previously looked
 * in out/make/ while forge.config.ts writes to out-final/, so it could never find
 * anything it had just built.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const installerSrc = path.join(repoRoot, "installer");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const args = process.argv.slice(2);
const target = (args.find((a) => !a.startsWith("--")) || detectHost()).toLowerCase();
const skipBuild = args.includes("--skip-build");
const requireAll = process.env.JOYCREATE_REQUIRE_ALL === "1";
const arch = process.arch === "arm64" ? "arm64" : "x64";

function detectHost() {
  switch (os.platform()) {
    case "win32": return "win";
    case "darwin": return "mac";
    case "linux": return "linux";
    default: throw new Error(`Unsupported host platform: ${os.platform()}`);
  }
}

/**
 * Forge's outDir, read from the config text. Importing forge.config.ts would
 * need a TypeScript loader and would run its module-level dependency walk, just
 * to learn one string.
 */
function forgeOutDir() {
  const text = readFileSync(path.join(repoRoot, "forge.config.ts"), "utf8");
  const m = text.match(/^\s*outDir:\s*["'`]([^"'`]+)["'`]/m);
  return path.join(repoRoot, m ? m[1] : "out");
}

const outDir = forgeOutDir();
const makeDir = path.join(outDir, "make");
const releaseDir = path.join(outDir, "installers");

// `required` artifacts fail the build when missing. `optional` ones warn: the
// MSI needs WiX Toolset v3 on the build machine, and a local developer build
// without it should still produce a working Setup.exe.
const TARGETS = {
  win: {
    label: "Windows",
    bootstrap: ["Install-JoyCreate.bat", "Install-JoyCreate.ps1", "README.txt"],
    artifacts: [
      { what: "Squirrel Setup.exe", dir: "squirrel.windows", match: /Setup\.exe$/i, required: true, inZip: true },
      { what: "MSI", dir: "wix", match: /\.msi$/i, required: false, inZip: true,
        hint: "Install WiX Toolset v3 (candle.exe / light.exe on PATH) to build the MSI." },
    ],
  },
  mac: {
    label: "macOS",
    bootstrap: ["Install-JoyCreate.command", "README.txt"],
    artifacts: [
      { what: "app zip", dir: "zip/darwin", match: /\.zip$/i, required: true, inZip: true },
      // A DMG is the conventional drag-to-Applications download. It is shipped
      // as its own asset rather than inside the zip, which would double its size.
      { what: "DMG", dir: ".", depth: 1, match: /\.dmg$/i, required: false, inZip: false,
        hint: "DMGs are only built on macOS." },
    ],
  },
  linux: {
    label: "Linux",
    bootstrap: ["install-joycreate.sh", "README.txt"],
    artifacts: [
      { what: ".deb", dir: "deb", match: /\.deb$/i, required: false, inZip: true },
      { what: ".rpm", dir: "rpm", match: /\.rpm$/i, required: false, inZip: true,
        hint: "Building .rpm needs rpmbuild (sudo apt-get install -y rpm)." },
      // The AppImage runs on any distro without root, which is what makes the
      // bootstrapper work on Arch and everything else the .deb/.rpm do not cover.
      { what: "AppImage", dir: "AppImage", match: /\.AppImage$/i, required: false, inZip: true,
        hint: "Building the AppImage needs mksquashfs (sudo apt-get install -y squashfs-tools)." },
    ],
    // At least one of these must exist, or there is nothing to install.
    anyOf: [".deb", ".rpm", "AppImage"],
  },
};

async function walk(dir, predicate, depth = Infinity) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 1) out.push(...(await walk(full, predicate, depth - 1)));
    } else if (predicate(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

const mb = async (file) => ((await fs.stat(file)).size / 1024 / 1024).toFixed(1);

/**
 * Refuse an installer that is a shell with nothing inside.
 *
 * Squirrel's Setup.exe carries the whole app as an embedded .nupkg. When that
 * embed fails, electron-winstaller still exits 0 and leaves a ~270 KB stub; the
 * build "succeeds" and the installer installs nothing. This happened on a real
 * build — a 1.16 GB nupkg beside a 267 KB Setup.exe — and every check
 * downstream (checksums, the zip, the release upload) passed it straight through.
 */
const MIN_PACKAGE_BYTES = 20 * 1024 * 1024;
async function assertRealPackage(file) {
  const size = (await fs.stat(file)).size;
  const sizeMb = (size / 1048576).toFixed(1);

  if (/Setup\.exe$/i.test(file)) {
    const dir = path.dirname(file);
    const nupkg = (await fs.readdir(dir)).find((n) => /-full\.nupkg$/i.test(n));
    if (nupkg) {
      const pkgSize = (await fs.stat(path.join(dir, nupkg))).size;
      // The nupkg is already compressed, so Setup.exe should be at least as big.
      if (size < pkgSize * 0.9) {
        throw new Error(
          `${path.basename(file)} is ${sizeMb} MB but ${nupkg} is ${(pkgSize / 1048576).toFixed(1)} MB: ` +
            `the app was not embedded, so this Setup.exe would install nothing. ` +
            `See "Setup.exe is only a few hundred KB" in docs/INSTALLER_PLAYBOOK.md.`,
        );
      }
      return;
    }
  }

  if (size < MIN_PACKAGE_BYTES) {
    throw new Error(
      `${path.basename(file)} is only ${sizeMb} MB — too small to contain the app. Refusing to ship it.`,
    );
  }
}
const step = (msg) => console.log(`\n==> ${msg}`);

async function main() {
  const cfg = TARGETS[target];
  if (!cfg) throw new Error(`Unknown target '${target}'. Use win | mac | linux.`);
  if (target !== detectHost()) {
    // Squirrel, WiX, DMG and AppImage all need their own OS's tooling. Cross
    // building "succeeds" with most makers silently skipped.
    throw new Error(`Cannot build ${cfg.label} installers on ${os.platform()}. Run this on ${cfg.label}, or use the "Build Installers" GitHub workflow.`);
  }

  if (!skipBuild) {
    step(`Running 'npm run make' for ${cfg.label} (this takes a while)...`);
    execSync("npm run make", { cwd: repoRoot, stdio: "inherit" });
  } else {
    step("Skipping build (--skip-build).");
  }

  step(`Collecting ${cfg.label} artifacts from ${path.relative(repoRoot, makeDir)}...`);
  const found = [];
  for (const a of cfg.artifacts) {
    const files = await walk(path.join(makeDir, a.dir), (n) => a.match.test(n), a.depth);
    if (files.length === 0) {
      if (a.required || requireAll) {
        throw new Error(
          `Missing ${a.what} under ${makeDir}.${a.hint ? ` ${a.hint}` : " Did 'npm run make' succeed?"}`,
        );
      }
      console.log(`    --  no ${a.what}${a.hint ? ` (${a.hint})` : ""}`);
      continue;
    }
    for (const f of files) {
      await assertRealPackage(f);
      console.log(`    OK  ${a.what}: ${path.relative(repoRoot, f)} (${await mb(f)} MB)`);
      found.push({ ...a, file: f });
    }
  }
  if (cfg.anyOf && !found.some((f) => cfg.anyOf.includes(f.what))) {
    throw new Error(`No installable package was built (need one of: ${cfg.anyOf.join(", ")}).`);
  }

  step("Staging installer zip...");
  const stage = path.join(outDir, `installer-stage-${target}`);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  for (const file of cfg.bootstrap) {
    const dst = path.join(stage, file);
    await fs.copyFile(path.join(installerSrc, file), dst);
    if (/\.(sh|command)$/.test(file)) await fs.chmod(dst, 0o755).catch(() => {});
  }
  for (const f of found.filter((f) => f.inZip)) {
    await fs.copyFile(f.file, path.join(stage, path.basename(f.file)));
  }

  await fs.mkdir(releaseDir, { recursive: true });
  const zipName = `JoyCreate-Installer-${cfg.label}-${arch}-${pkg.version}.zip`;
  const zipPath = path.join(releaseDir, zipName);
  await fs.rm(zipPath, { force: true });
  const zip = new AdmZip();
  zip.addLocalFolder(stage);
  zip.writeZip(zipPath);
  console.log(`    OK  ${zipName} (${await mb(zipPath)} MB)`);

  step("Copying standalone packages and writing checksums...");
  const released = [zipPath];
  for (const f of found) {
    const dst = path.join(releaseDir, path.basename(f.file));
    await fs.copyFile(f.file, dst);
    released.push(dst);
  }
  // `sha256sum -c` format: two spaces, then the bare file name.
  const lines = [];
  for (const file of released) lines.push(`${await sha256(file)}  ${path.basename(file)}`);
  const sumsPath = path.join(releaseDir, `SHA256SUMS-${target}-${arch}.txt`);
  await fs.writeFile(sumsPath, lines.join("\n") + "\n");

  console.log(`\n=====================================================`);
  console.log(`  ${cfg.label} installers ready in ${path.relative(repoRoot, releaseDir)}`);
  console.log(`=====================================================`);
  for (const l of lines) console.log(`  ${l}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\nXX  ${err.message}`);
  process.exit(1);
});
