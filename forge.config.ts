import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerWix } from "@electron-forge/maker-wix";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerAppImage } from "@reforged/maker-appimage";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { builtinModules } from "module";

// Path to signtool.exe bundled with electron-winstaller
// On GitHub Actions, this is the full path to the signtool binary.
const SIGNTOOL_PATH = path.join(
  __dirname,
  "node_modules",
  "electron-winstaller",
  "vendor",
  "signtool.exe",
);

/**
 * Signs a Windows executable using DigiCert's signtool.
 */
function signWindowsExecutable(filePath: string): void {
  const certHash = process.env.SM_CODE_SIGNING_CERT_SHA1_HASH;
  if (!certHash) {
    console.log(
      `[postMake] SM_CODE_SIGNING_CERT_SHA1_HASH not set, skipping signing`,
    );
    return;
  }

  console.log(`[postMake] Signing: ${filePath}`);
  const signParams = `/sha1 ${certHash} /tr http://timestamp.digicert.com /td SHA256 /fd SHA256`;
  const cmd = `"${SIGNTOOL_PATH}" sign ${signParams} "${filePath}"`;

  try {
    execSync(cmd, { stdio: "inherit" });
    console.log(`[postMake] Signing successful: ${filePath}`);
  } catch (error) {
    console.error(`[postMake] Signing failed for ${filePath}:`, error);
    throw error;
  }
}

// Based on https://github.com/electron/forge/blob/6b2d547a7216c30fde1e1fddd1118eee5d872945/packages/plugin/vite/src/VitePlugin.ts#L124

// Which node_modules the packaged app ships.
//
// Vite bundles most code straight into .vite/build (main process) and the
// renderer; only what the built bundle still `require()`s at runtime — the
// externals in vite.main.config.mts, and their transitive deps — has to exist
// in node_modules inside the asar.
//
// This used to seed the closure with EVERY package.json dependency. That was
// safe, but it shipped renderer-only libraries Vite had already bundled
// (Privy, thirdweb, monaco, WalletConnect…) and optional runtimes nothing
// loads: 4.05 GB of node_modules, a 4.6 GB app, and a Squirrel Setup.exe that
// could not be built at all. Seeding from what the bundle actually requires
// ships 1.63 GB instead.
//
// Set JOYCREATE_FULL_DEP_CLOSURE=1 to go back to shipping everything.
function getProductionDependencies(): string[] {
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
  );
  return Object.keys(pkgJson.dependencies || {});
}

// Packages the app reaches by filesystem path, which no require-scan can see.
const PATH_LOADED_PACKAGES = [
  "openclaw", // node_modules/openclaw/dist/control-ui — openclaw_gateway_service.ts
  "sqlite-vec", // app.asar.unpacked/node_modules/sqlite-vec — sqlite_vec_backend.ts
];

/**
 * Every package the built main-process bundles require by name.
 *
 * Returns null when there is no build to scan. A false positive (a package
 * name inside a code template string) costs only size; a miss would crash, so
 * the pattern errs wide: require(), require.resolve(), import() and `from`.
 */
function getBundleRuntimePackages(): string[] | null {
  const buildDir = path.join(__dirname, ".vite", "build");
  if (!fs.existsSync(buildDir)) return null;

  const builtins = new Set(builtinModules);
  const specifier =
    /(?:\brequire(?:\.resolve)?|\bimport)\(\s*["']([^"'./][^"']*)["']\s*[,)]|\bfrom\s*["']([^"'./][^"']*)["']/g;
  const packageName = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
  const names = new Set<string>(PATH_LOADED_PACKAGES);

  const scan = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!/\.(c|m)?js$/.test(entry.name)) continue;
      const code = fs.readFileSync(full, "utf8");
      for (const m of code.matchAll(specifier)) {
        const spec = m[1] ?? m[2];
        if (!spec || spec.startsWith("node:") || builtins.has(spec)) continue;
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        if (name === "electron" || !packageName.test(name)) continue;
        names.add(name);
      }
    }
  };
  scan(buildDir);
  return [...names];
}

// Resolve the full transitive dependency closure of the externalized packages.
// Without this, packaging would only include the top-level package and runtime
// would fail with "Cannot find module 'X'" for any transitive dep.
function resolvePackageDir(name: string, fromDir: string): string | null {
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function computeRuntimeDepClosure(roots: string[]): Set<string> {
  // Collect set of allow-prefixes (relative to project root, with leading "/")
  // covering every directory in the dep closure, including nested node_modules.
  const allowPrefixes = new Set<string>();
  // Set of exact directory paths that must be traversable (parent dirs of any
  // package in the closure). For these we allow the exact path but do NOT
  // recursively allow children — children are gated by their own prefix entry.
  const allowExact = new Set<string>();
  const visited = new Set<string>(); // paths
  const projectRoot = __dirname;

  const addAllowPrefix = (rel: string) => {
    allowPrefixes.add(rel);
    // Also allow every ancestor directory exactly so packager can traverse to
    // it (e.g. `/node_modules/@pinojs` for `/node_modules/@pinojs/redact`).
    let p = rel;
    while (true) {
      const idx = p.lastIndexOf("/");
      if (idx <= 0) break;
      p = p.substring(0, idx);
      allowExact.add(p);
    }
  };

  const visit = (name: string, fromDir: string) => {
    const dir = resolvePackageDir(name, fromDir);
    if (!dir) return;
    if (visited.has(dir)) return;
    visited.add(dir);
    const rel = "/" + path.relative(projectRoot, dir).split(path.sep).join("/");
    addAllowPrefix(rel);
    let pkg: {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      return;
    }
    const deps = {
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    };
    for (const d of Object.keys(deps)) visit(d, dir);
  };
  for (const r of roots) visit(r, projectRoot);
  // Stash exact set on the prefix set object for the ignore filter to use.
  (allowPrefixes as Set<string> & { __exact?: Set<string> }).__exact = allowExact;
  return allowPrefixes;
}

/**
 * Computed on first use, not when this file loads.
 *
 * Forge loads this config before the Vite build runs, so scanning .vite/build
 * at load time would read the previous build — or none. The packager calls
 * `ignore` only after the build has finished, which is when this first runs.
 */
let runtimeDepClosure: Set<string> | undefined;
function getRuntimeDepClosure(): Set<string> {
  if (runtimeDepClosure) return runtimeDepClosure;
  const fromBundle =
    process.env.JOYCREATE_FULL_DEP_CLOSURE === "1"
      ? null
      : getBundleRuntimePackages();
  const roots = fromBundle ?? getProductionDependencies();
  runtimeDepClosure = computeRuntimeDepClosure(roots);
  console.log(
    `[forge.config] Including ${runtimeDepClosure.size} package directories in asar ` +
      (fromBundle
        ? `(closure of ${roots.length} packages the built main process requires)`
        : "(every production dependency)"),
  );
  return runtimeDepClosure;
}

const ignore = (file: string) => {
  if (!file) return false;
  // `file` always starts with `/`
  // @see - https://github.com/electron/packager/blob/v18.1.3/src/copy-filter.ts#L89-L93
  if (file === "/node_modules") {
    return false;
  }
  if (file.startsWith("/drizzle")) {
    return false;
  }
  if (file.startsWith("/scaffold")) {
    return false;
  }

  if (file.startsWith("/worker") && !file.startsWith("/workers")) {
    return false;
  }
  if (file.startsWith("/node_modules/stacktrace-js")) {
    return false;
  }
  if (file.startsWith("/node_modules/stacktrace-js/dist")) {
    return false;
  }
  if (file.startsWith("/node_modules/html-to-image")) {
    return false;
  }
  if (file.startsWith("/node_modules/better-sqlite3")) {
    return false;
  }
  if (file.startsWith("/node_modules/bindings")) {
    return false;
  }
  if (file.startsWith("/node_modules/file-uri-to-path")) {
    return false;
  }
  if (file.startsWith("/.vite")) {
    return false;
  }
  // Packages externalized in vite.main.config.mts must be present in
  // node_modules at runtime, otherwise the main process throws
  // "Cannot find module 'X'" before the window can load.
  const closure = getRuntimeDepClosure();
  const exact = (closure as Set<string> & { __exact?: Set<string> }).__exact;
  if (exact && exact.has(file)) {
    return false;
  }
  for (const prefix of closure) {
    if (file === prefix || file.startsWith(prefix + "/")) {
      return false;
    }
  }

  return true;
};

const isEndToEndTestBuild = process.env.E2E_TEST_BUILD === "true";

// Signing and notarization need secrets only the release pipeline holds.
// Without these guards an unsigned build — a developer's `npm run make`, or the
// "Build Installers" workflow run without secrets — failed at the notarize step
// instead of producing a working, if unsigned, app.
const canSignMac = !isEndToEndTestBuild && Boolean(process.env.APPLE_TEAM_ID);
const canNotarizeMac =
  canSignMac && Boolean(process.env.APPLE_ID && process.env.APPLE_PASSWORD);

/**
 * Is a build tool on PATH?
 *
 * The MSI needs WiX Toolset v3 and the AppImage needs mksquashfs. A maker whose
 * tool is missing is left out with a warning, rather than failing the whole
 * `make` — which would also take down the Squirrel, deb and rpm builds, and the
 * existing release workflow, which installs neither tool.
 */
function hasBinary(name: string): boolean {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter);
  return dirs.some(
    (dir) => dir && exts.some((ext) => fs.existsSync(path.join(dir, name + ext))),
  );
}

/** Only a real `make`/`publish` should warn; `npm start` loads this file too. */
const isMaking = process.argv.some((a) => a === "make" || a === "publish");

/**
 * Include a maker only when the tool it shells out to is installed on this
 * machine. `onPlatform` is the OS the maker builds for: on any other OS Forge
 * skips the maker anyway, so it is kept without checking for the tool.
 */
function optionalMaker<T>(
  label: string,
  onPlatform: NodeJS.Platform,
  toolsPresent: () => boolean,
  missing: string,
  create: () => T,
): T[] {
  if (process.platform !== onPlatform || toolsPresent()) return [create()];
  if (isMaking) console.warn(`[forge] ${label} skipped: ${missing}`);
  return [];
}

const config: ForgeConfig = {
  outDir: "out-final",
  packagerConfig: {
    protocols: [
      {
        name: "JoyCreate",
        schemes: ["joycreate"],
      },
    ],
    icon: "./assets/icon/logo",

    osxSign: canSignMac
      ? {
          identity: process.env.APPLE_TEAM_ID,
        }
      : undefined,
    osxNotarize: canNotarizeMac
      ? {
          appleId: process.env.APPLE_ID!,
          appleIdPassword: process.env.APPLE_PASSWORD!,
          teamId: process.env.APPLE_TEAM_ID!,
        }
      : undefined,
    asar: true,
    ignore,
    extraResource: ["node_modules/dugite/git"],
    // ignore: [/node_modules\/(?!(better-sqlite3|bindings|file-uri-to-path)\/)/],
  },
  rebuildConfig: {
    extraModules: ["better-sqlite3"],
    force: true,
    // Only rebuild the top-level better-sqlite3, not nested ones in n8n-nodes-langchain
    onlyModules: ["better-sqlite3"],
  },
  hooks: {
    postMake: async (_forgeConfig, makeResults) => {
      for (const result of makeResults) {
        // Only sign Windows artifacts
        if (result.platform !== "win32") {
          continue;
        }

        console.log(
          `[postMake] Processing Windows artifacts for ${result.arch}`,
        );
        for (const artifact of result.artifacts) {
          const fileName = path.basename(artifact).toLowerCase();
          // Sign .exe files (the Squirrel installer and Setup.exe) and the MSI.
          // An unsigned MSI gets a SmartScreen warning and is refused outright
          // by many managed-PC policies, which are the reason to ship an MSI.
          if (fileName.endsWith(".exe") || fileName.endsWith(".msi")) {
            signWindowsExecutable(artifact);
          }
        }
      }
      return makeResults;
    },
  },
  makers: [
    new MakerSquirrel({
      setupIcon: "./assets/icon/logo.ico",
      iconUrl:
        "https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/assets/icon/logo.ico",
    }),
    // The MSI. Setup.exe installs per-user with no admin, which suits
    // individuals; IT departments deploy with Group Policy, Intune or SCCM,
    // which expect a per-machine MSI.
    ...optionalMaker(
      "MSI",
      "win32",
      () => hasBinary("candle") && hasBinary("light"),
      "WiX Toolset v3 not found (candle.exe and light.exe must be on PATH).",
      () =>
        new MakerWix({
          // Never change this. It is how Windows Installer recognises a new
          // MSI as an upgrade of the installed one. Left unset, electron-wix-msi
          // generates a random code per build, and every release then installs
          // side by side with the last.
          upgradeCode: "89A4928C-50C3-47FF-BAE4-08C4B54FE77E",
          name: "JoyCreate",
          programFilesFolderName: "JoyCreate",
          shortcutFolderName: "JoyCreate",
          icon: "./assets/icon/logo.ico",
          defaultInstallMode: "perMachine",
          ui: { chooseDirectory: true },
        }),
    ),
    new MakerZIP({}, ["darwin"]),
    // Drag-to-Applications disk image, the download Mac users expect.
    new MakerDMG({
      format: "ULFO",
      icon: "./assets/icon/logo.icns",
    }),
    ...optionalMaker(
      "rpm",
      "linux",
      () => hasBinary("rpmbuild"),
      "rpmbuild not found (install the rpm package).",
      () => new MakerRpm({}),
    ),
    ...optionalMaker(
      "deb",
      "linux",
      () => hasBinary("dpkg") && hasBinary("fakeroot"),
      "dpkg and fakeroot not found.",
      () =>
        new MakerDeb({
          options: {
            mimeType: ["x-scheme-handler/joycreate"],
          },
        }),
    ),
    // Runs on any distro without root. It is the only package for Arch,
    // Gentoo, NixOS and everything else the .deb and .rpm do not cover.
    ...optionalMaker(
      "AppImage",
      "linux",
      () => hasBinary("mksquashfs"),
      "mksquashfs not found (install squashfs-tools).",
      () =>
        new MakerAppImage({
          options: {
            icon: "./assets/icon/logo.png",
            categories: ["Development"],
            mimeType: ["x-scheme-handler/joycreate"],
          },
        }),
    ),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "DisciplesofLove",
          name: "JoyCreate",
        },
        draft: true,
        force: true,
        prerelease: true,
      },
    },
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // Disable concurrent builds to prevent resource contention on Windows
      // when building the large main process bundle (3800+ modules)
      concurrent: false,
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
        {
          entry: "workers/tsc/tsc_worker.ts",
          config: "vite.worker.config.mts",
          target: "main",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]:
        isEndToEndTestBuild || process.env.JOY_DEBUG_BUILD === "1",
      // Asar integrity validation requires the binary to be signed with
      // @electron/windows-sign so the integrity blocks are embedded in the
      // .exe resources. For unsigned local builds this causes loadFile from
      // asar to fail silently (window opens with title "Error"). Disable for
      // unsigned local builds; CI/release builds re-enable via env var.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
        process.env.JOY_SIGN_WINDOWS === "1",
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;




