# JoyCreate Installer Playbook

How to build, sign, publish, install and deploy JoyCreate on Windows, macOS and
Linux. The short version: **Actions → Build Installers → Run workflow.**

---

## 1. What ships

One build produces all of these. Each platform is built on its own OS, because
installers can't be cross-built.

| Platform | File | Who it's for | Admin? |
|---|---|---|---|
| Windows | `JoyCreate-Installer-Windows-x64-<ver>.zip` | Everyone — double-click `Install-JoyCreate.bat` | No |
| Windows | `joycreate-<ver>.Setup.exe` | A plain one-file download | No (per-user) |
| Windows | `JoyCreate.msi` | IT, Group Policy, Intune, SCCM | **Yes** (per-machine) |
| macOS | `JoyCreate-<ver>-arm64.dmg` / `-x64.dmg` | Drag-to-Applications | Password |
| macOS | `JoyCreate-Installer-macOS-<arch>-<ver>.zip` | Guided install with companions | Password |
| Linux | `joycreate_<ver>_amd64.deb` | Ubuntu, Debian, Mint, Pop!_OS | sudo |
| Linux | `joycreate-<ver>-1.x86_64.rpm` | Fedora, RHEL, Rocky, openSUSE | sudo |
| Linux | `JoyCreate-<ver>-x64.AppImage` | **Any** distro — Arch, NixOS, Gentoo… | No |
| Linux | `JoyCreate-Installer-Linux-x64-<ver>.zip` | Guided install; picks deb/rpm/AppImage | sudo, or none for AppImage |
| All | `SHA256SUMS.txt` | Verification — the web installers require it | — |

Plus two web one-liners that fetch the right zip, verify its checksum, and run it:

```powershell
irm https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.sh | bash
```

---

## 2. The push button

### Release a version

1. **Bump the version** in `package.json` (e.g. `0.32.0-beta.2`) and merge to `main`.
2. **GitHub → Actions → Build Installers → Run workflow.**
   - Branch: `main`
   - **publish**: ✅ to upload to a draft release. Leave it off for a test build.
   - **sign**: ✅ for real releases, ❌ for a quick unsigned test.
3. Wait ~30–60 minutes. Four jobs run in parallel: Windows x64, Linux x64,
   macOS arm64, macOS x64. Each job's summary lists its checksums.
4. A final job merges the checksums, runs `sha256sum -c` over every file, and
   creates or updates the **draft** release `v<version>`.
5. **Test the draft** (section 6), then open the release on GitHub and click
   **Publish release**.

Pushing a tag does the same with publish and sign both on:

```bash
git tag v0.32.0-beta.2
git push origin v0.32.0-beta.2
```

The workflow refuses a tag that doesn't match `package.json`.

> **Nothing reaches users until you publish the draft.** Unauthenticated
> visitors can't see drafts, so the web one-liners keep serving the previous
> release until then. That's your safety window.

### Unsigned test build

Run the workflow with **publish** and **sign** unticked. Download the files
from the run's **Artifacts** section (kept 14 days). No release is touched.

### What `release.yml` is

`release.yml` is the older `electron-forge publish` pipeline. It uploads raw
Forge artifacts (including Squirrel's `RELEASES` and `.nupkg` update feed) and
runs `verify-release-assets.js`. It still works, and it now also gets the DMG
(and the MSI/AppImage only if WiX or mksquashfs happen to be on the runner).
`installers.yml` is the one that produces the one-click zips, the MSI,
the AppImage and `SHA256SUMS.txt`. Running both against the same version
uploads to the same release, which is fine.

---

## 3. Before the first real release

- [ ] **Publisher name.** `package.json` `"author"` is `Will Chen <willchen90@gmail.com>`,
      inherited from the upstream project. It becomes the MSI **Manufacturer** and
      the Squirrel publisher — the name shown in *Settings → Apps* and in UAC
      prompts on every user's PC. Change it to the name you want users to see.
- [ ] **Signing secrets** are set in the `release` environment (section 5).
      Unsigned builds work, but users see scary warnings.
- [ ] **Repository is public**, or the web one-liners can't download anything
      (they call the GitHub API unauthenticated).
- [ ] **`installer/web/` is on `main`.** The one-liners fetch the scripts from
      `main`, so they have to be merged there.

### Never change

- **The MSI `upgradeCode`** in `forge.config.ts`
  (`89A4928C-50C3-47FF-BAE4-08C4B54FE77E`). It's how Windows Installer knows a
  new MSI replaces the old one. electron-wix-msi makes up a random one per build
  if none is set, and then every release installs *alongside* the previous one.
- **The app name `JoyCreate`**, for the same reason: install paths and shortcuts
  derive from it.

---

## 4. Building locally

The same script CI runs. It has to run on the OS you're building for.

```bash
npm ci
npm run installer              # full make + package, for this OS
npm run installer:repack       # reuse the last make, just re-zip
```

Output goes to `out-final/installers/`. Set `JOYCREATE_REQUIRE_ALL=1` to fail
when any package is missing, the way CI does.

### Windows

| Need | For | Get it |
|---|---|---|
| Node 20+ | everything | nodejs.org |
| **WiX Toolset v3.14** | the `.msi` | `choco install wixtoolset --version=3.14.1` (admin), or **without admin**: unzip `wix314-binaries.zip` from github.com/wixtoolset/wix3/releases (tag `wix3141rtm`) into `%LOCALAPPDATA%\Programs\WiX Toolset v3.14\bin` and put that folder on `PATH` for the build |

Without WiX the build still produces `Setup.exe`, prints
`MSI skipped: WiX Toolset v3 not found`, and leaves the MSI out.
**It has to be WiX v3.** WiX v4+ (`dotnet tool install wix`) is a different CLI
that electron-wix-msi doesn't support. Make sure `candle.exe` and `light.exe`
are on `PATH` — the installer doesn't always add them.

### macOS

Xcode Command Line Tools (`xcode-select --install`). The build produces a DMG
and a zip for the Mac's own architecture; to get both arm64 and x64, use CI.

Without `APPLE_TEAM_ID` the app is unsigned and un-notarized. It runs, but only
after the user right-clicks → **Open**.

### Linux

```bash
sudo apt-get install -y rpm squashfs-tools
```

`rpm` builds the `.rpm`; `squashfs-tools` (for `mksquashfs`) builds the
AppImage. Missing either, that package is skipped with a message and the rest
still build.

---

## 5. Code signing

Unsigned installers work, but:

- **Windows:** SmartScreen says *"Windows protected your PC"*; users must click
  *More info → Run anyway*. Many company PCs block unsigned MSIs outright.
- **macOS:** Gatekeeper says the app *"cannot be opened because the developer
  cannot be verified."* Users must right-click → **Open**, or run
  `xattr -dr com.apple.quarantine /Applications/JoyCreate.app`.
- **Linux:** no signing is expected.

### Secrets (repository → Settings → Environments → `release`)

| Secret | Used for |
|---|---|
| `SM_HOST`, `SM_API_KEY`, `SM_CLIENT_CERT_FILE_B64`, `SM_CLIENT_CERT_PASSWORD` | DigiCert KeyLocker login |
| `SM_CODE_SIGNING_CERT_SHA1_HASH` | Which certificate signs `Setup.exe` and the `.msi` |
| `DIGICERT_KEYPAIR_ALIAS` | Syncing the certificate onto the runner |
| `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD` | Developer ID Application certificate |
| `APPLE_TEAM_ID` | Signing identity (signing happens only when this is set) |
| `APPLE_ID`, `APPLE_PASSWORD` | Notarization (an app-specific password, not the account password) |

The workflow signs only when the secrets exist and **sign** is ticked. If
they're missing, you get a working unsigned build rather than a failed run.

---

## 6. Test before publishing

Do this on clean machines or VMs, not a developer box, where a leftover
install or a PATH entry can hide a broken installer.

| Check | How |
|---|---|
| Checksums | `sha256sum -c SHA256SUMS.txt` (macOS: `shasum -a 256 -c`) |
| Windows zip | Extract → `Install-JoyCreate.bat -NoCompanions` → app launches, Desktop shortcut exists |
| Windows MSI | Admin PowerShell: `msiexec /i JoyCreate.msi /qn /l*v msi.log`; exit code 0; app in Start menu |
| MSI upgrade | Install the previous MSI, then the new one → exactly **one** JoyCreate in *Settings → Apps* |
| macOS DMG | Open → drag to Applications → launches without a Gatekeeper block (if signed) |
| Ubuntu | `sudo apt install ./joycreate_*.deb` → launches from the app menu |
| Fedora | `sudo dnf install ./joycreate-*.rpm` → launches |
| Other Linux | `./install-joycreate.sh --appimage` → launches, menu entry appears |
| Web one-liner | Once the release is **published**, run it on a clean VM |
| Deep link | Open `joycreate://` in a browser → JoyCreate opens |

The web one-liners can only be tested after publishing, since drafts are
invisible to them. Publishing a *prerelease* first is a reasonable way to do that.

---

## 7. Installing — for end users

### The one-liners

**Windows** — open PowerShell (no admin needed):

```powershell
irm https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.ps1 | iex
```

**macOS / Linux** — open Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.sh | bash
```

Both find the newest release, download the zip for your OS and CPU, **refuse to
continue if the SHA-256 doesn't match**, and run the guided installer.

### Options

| Want | Windows | macOS / Linux |
|---|---|---|
| Install everything, no prompts | `-Full` | `--full` |
| JoyCreate only | `-NoCompanions` | `--no-companions` |
| Specific version | `-Version 0.32.0-beta.1` | `--version 0.32.0-beta.1` |
| MSI for all users (admin) | `-UseMsi` | — |
| AppImage, no root | — | `--appimage` |
| Skip the starter Ollama model | `-SkipOllamaModel` | `--skip-model` |

A piped `iex` can't take parameters, so on Windows use:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.ps1))) -Full
```

```bash
curl -fsSL https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.sh | bash -s -- --full
```

### What the guided installer does

1. Installs JoyCreate.
2. Offers optional companions: **Ollama** (local models), **LibreOffice**
   (document export), **Docker** (n8n / Celestia).
3. Offers to pull a starter model (`llama3.2:3b`, ~2 GB).
4. Creates a shortcut and launches the app.

It stops with an error, rather than reporting success, if the install exits
non-zero or `JoyCreate.exe` isn't on disk afterwards.

---

## 8. Deploying to many machines

### Windows — MSI

The MSI installs **per-machine** (Program Files, all users), which is what
fleet tools expect.

```powershell
# Install, silent, with a log
msiexec /i JoyCreate.msi /qn /norestart /l*v C:\Windows\Temp\joycreate-install.log

# Uninstall, silent
msiexec /x JoyCreate.msi /qn /norestart
```

Exit codes: `0` success · `3010` success, restart needed · `1603` fatal error
(read the log) · `1925` not elevated.

| Tool | How |
|---|---|
| **Intune** | Apps → Windows → *Line-of-business app* → upload the `.msi`. Install behaviour: System. |
| **Group Policy** | Put the `.msi` on a share readable by *Domain Computers* → Computer Configuration → Software Installation → New Package (*Assigned*). |
| **SCCM / ConfigMgr** | Application → Windows Installer (`.msi`) → detection method is generated from the MSI. |
| **PDQ / RMM** | Run the `msiexec` line above as SYSTEM. |

Upgrades: deploy the new MSI the same way. Because the `upgradeCode` is fixed,
it replaces the old version in place.

> Don't mix installers on one PC. `Setup.exe` (per-user, `%LOCALAPPDATA%`) and
> the MSI (per-machine, Program Files) are independent installs. Using both
> leaves two copies.

### Linux — packages

```bash
# Debian / Ubuntu
sudo apt-get install -y ./joycreate_<ver>_amd64.deb
# Fedora / RHEL
sudo dnf install -y ./joycreate-<ver>-1.x86_64.rpm
```

Ansible, for a fleet:

```yaml
- name: Install JoyCreate
  hosts: workstations
  become: true
  vars:
    joycreate_version: "0.32.0-beta.1"
    base: "https://github.com/DisciplesofLove/JoyCreate/releases/download/v{{ joycreate_version }}"
  tasks:
    - name: Debian family
      ansible.builtin.apt:
        deb: "{{ base }}/joycreate_{{ joycreate_version | replace('-beta.', '.beta.') }}_amd64.deb"
      when: ansible_os_family == "Debian"

    - name: RedHat family
      ansible.builtin.dnf:
        name: "{{ base }}/joycreate-{{ joycreate_version | replace('-beta.', '.beta.') }}-1.x86_64.rpm"
        disable_gpg_check: true
      when: ansible_os_family == "RedHat"
```

The `replace` is there because deb and rpm spell a beta `0.32.0.beta.1`, not
`0.32.0-beta.1`. Check the real file names on the release page before relying
on this.

### macOS — MDM

Most MDMs (Jamf, Kandji, Intune for Mac) want a signed `.pkg`, and **the build
doesn't produce one yet**. For now, deploy the DMG with a script that mounts it
and copies `JoyCreate.app` to `/Applications`, or add
`@electron-forge/maker-pkg` when MDM rollout is needed.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Setup.exe is only a few hundred KB** (build stops: *"the app was not embedded"*) | Squirrel failed to embed the `.nupkg`. Its embed tool is 32-bit, and the package is too big to load. `Squirrel-Releasify.log` says `Failed to write Zip to Setup.exe`, yet `make` still exits 0 | The app has grown back. Check the build log's `Including N package directories` line: is `JOYCREATE_FULL_DEP_CLOSURE` set, or did a big package become a main-process `require`? See section 9a |
| Build prints `MSI skipped: WiX Toolset v3 not found` | No `candle.exe` on PATH | Install WiX **v3.14** and add its `bin` to PATH (section 4) |
| CI Windows job fails: `Missing MSI` | WiX didn't install on the runner | Check the *Install WiX Toolset v3* step log |
| `AppImage skipped: mksquashfs not found` | squashfs-tools missing | `sudo apt-get install -y squashfs-tools` |
| Two JoyCreate entries in *Settings → Apps* | Setup.exe **and** MSI installed, or an MSI built without the fixed `upgradeCode` | Uninstall both; install one kind |
| MSI exit `1925` | Not elevated | Run as administrator, or use `Setup.exe` |
| MSI exit `1603` | Generic failure | Read the `/l*v` log and search for `Return value 3` |
| Web installer: *"no SHA256SUMS.txt"* | Release was uploaded without it | Re-run the workflow with **publish** on; never upload by hand |
| Web installer: *"No published release"* | The release is still a draft | Publish it |
| Web installer: *"Could not reach the GitHub API"* | Repo is private, offline, or rate-limited (60 req/hr per IP) | Download the zip from the release page |
| *"Windows protected your PC"* | Unsigned build | Sign it (section 5), or *More info → Run anyway* |
| macOS: *"cannot be opened"* | Unsigned or un-notarized | Sign and notarize, or right-click → Open |
| AppImage won't start, mentions FUSE | libfuse missing | `sudo apt-get install -y libfuse2`, or `APPIMAGE_EXTRACT_AND_RUN=1` |
| AppImage exits with a `chrome-sandbox` / SUID error | Distro restricts unprivileged user namespaces (e.g. Ubuntu 24.04 AppArmor) | Use the `.deb`, or launch with `--no-sandbox` understanding that it disables Chromium's sandbox |
| Arch: installer used the AppImage | Expected — there's no native Arch package | Nothing to fix |

---

## 9a. App size and the Windows installers

**Fixed 2026-09-15.** The app used to be too big for Squirrel to build a
working `Setup.exe`. Measured on real Windows builds of `0.32.0-beta.1`:

| | Before | After |
|---|---|---|
| Packaged app | 4.6 GB | **2.1 GB** |
| `app.asar` | 4.0 GB | 1.55 GB |
| `node_modules` directories packed | 2,714 | 1,128 |
| Squirrel `-full.nupkg` | 1.16 GB | 585 MB |
| `Setup.exe` | **267 KB, empty** | **583 MB, working** |
| `JoyCreate.msi` | not built | 602 MB |

### How it's kept small

`forge.config.ts` packs only what the built main process needs at runtime:

1. After Vite builds, it scans `.vite/build` for every package name that's
   `require()`d, `require.resolve()`d, `import()`ed or imported `from`.
2. It adds `PATH_LOADED_PACKAGES`: packages the app reaches by file path, which
   no scan can see (`openclaw`'s control UI, `sqlite-vec`).
3. It packs the transitive closure of those, rather than every
   `package.json` dependency. Renderer-only libraries are already bundled into
   the renderer by Vite, so their `node_modules` copies are no longer shipped.

The build log shows which mode ran:
`[forge.config] Including 1128 package directories in asar (closure of 73 packages the built main process requires)`.

- **If you add code that loads a package by file path** (not `require`), add
  it to `PATH_LOADED_PACKAGES`, or it won't be in the installer.
- **Escape hatch:** `JOYCREATE_FULL_DEP_CLOSURE=1` packs every dependency, as
  before. Expect the 4.6 GB app and a broken `Setup.exe`.

### How the slim app was verified

| Check | Result |
|---|---|
| Every package the packaged bundle requires by name is inside the package | Pass. The six "missing" names are template strings or behind a fallback (e.g. `jsdom` → `linkedom`), and were absent from the old build too |
| Boot the packaged `JoyCreate.exe` for 90 s on an isolated profile | Pass. Renderer loaded, IPC handlers and DB migrations ran, MCP tools loaded, no module errors, no uncaught errors |
| Extract the MSI (`msiexec /a`) and compare to the packaged app | `JoyCreate.exe` and `app.asar` byte-identical |
| Squirrel `RELEASES` SHA-1 and size vs the `.nupkg` | Match |
| `sha256sum -c` over the release files | Pass |

**Not yet verified:** a real install of `Setup.exe` or the MSI on a clean
machine, and lazily loaded features beyond startup. Section 6 is the checklist
for that.

### Squirrel's ceiling

`WriteZipToSetup.exe` is 32-bit. A 585 MB package embedded fine and a 1.16 GB
one failed. The exact limit in between is unknown, so keep the `.nupkg` well
under 1 GB. If it creeps up, `build-installer.mjs` fails the build rather than
shipping an empty installer.

### Running the packaged app for a test — isolate it

`--user-data-dir` isolates the app's data folder but **not** the home
directory. The app reads bot tokens from `~/.openclaw` and loads `.env` from the
working directory. A test launch with only `--user-data-dir` found a real
Telegram token and started polling against the live bot. It also auto-starts
n8n and a Celestia node in visible console windows. For a test boot, set
`USERPROFILE` and `HOME` to a scratch folder, run from a scratch working
directory, and close any n8n or Celestia windows afterwards.

---

## 9b. History: the original blocker

Measured on a real Windows build of `0.32.0-beta.1` (2026-09-15):

| Piece | Size |
|---|---|
| Packaged app (`out-final/JoyCreate-win32-x64`) | **4.6 GB** |
| `resources/app.asar` | 4.0 GB (3.87 GB of content, 1,821 top-level entries) |
| Squirrel `-full.nupkg` | 1.16 GB |
| `Setup.exe` produced | **267 KB — empty** |

**Why.** Squirrel builds `Setup.exe` by embedding the `.nupkg` into a stub with
`WriteZipToSetup.exe`, a 32-bit process without large-address awareness (2 GB
of address space). It can't load a 1.16 GB package, logs
`Failed to update resource`, and electron-winstaller exits 0 anyway.

**Why the app is 4.6 GB.** `forge.config.ts` packs the *entire*
production-dependency closure into the asar, deliberately, to avoid
`Cannot find module` crashes in the packaged main process. That includes
renderer-only libraries Vite has already bundled into the renderer, plus large
optional runtimes. The biggest entries:

| MB | Package |
|---|---|
| 444 | `@privy-io/react-auth` |
| 345 | `@huggingface/transformers` |
| 252 | `onnxruntime-node` |
| 434 | `@anthropic-ai/claude-code` + `-win32-x64` |
| 211 | `x402` |
| 190 | `googleapis` |
| 143 | `openclaw` |
| 128 | `onnxruntime-web` |
| 123 | `dugite` |
| 123 | `rocksdb-native` |
| 104 | `thirdweb` |
| 94 | `monaco-editor` |

This was resolved by the first fix below (section 9a); the numbers above are
the "before" state. Two further options remain available if the app grows
again:

- **Download heavy optional runtimes on first use** instead of shipping them:
  the Claude Code SDK, transformers/ONNX, and the rocksdb stack.
- **Lean on the MSI.** WiX writes its own cabinet and never goes through
  `WriteZipToSetup`, but cabinets and MSI files have their own 2 GB ceiling.

Still true today: `release.yml` (`electron-forge publish`) has **no**
empty-installer check. If `Setup.exe` ever fails to embed again, it will
upload the stub as though it worked. `installers.yml` will not.

---

## 10. Where everything lives

| Path | Role |
|---|---|
| `.github/workflows/installers.yml` | The push button — builds all platforms, drafts the release |
| `.github/workflows/release.yml` | Older `electron-forge publish` pipeline |
| `forge.config.ts` | Makers: Squirrel, WiX (MSI), ZIP, DMG, deb, rpm, AppImage; signing |
| `scripts/build-installer.mjs` | Builds one platform's packages + zip + checksums |
| `installer/Install-JoyCreate.bat` / `.ps1` | Windows guided installer |
| `installer/Install-JoyCreate.command` | macOS guided installer |
| `installer/install-joycreate.sh` | Linux guided installer (deb / rpm / AppImage) |
| `installer/web/install.ps1` | Windows web one-liner |
| `installer/web/install.sh` | macOS / Linux web one-liner |
| `installer/README.txt` | The README inside every installer zip |
