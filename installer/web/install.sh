#!/usr/bin/env bash
# JoyCreate web installer for Linux and macOS -- the "one button" path.
#
#   curl -fsSL https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.sh | bash
#
# With options:
#
#   curl -fsSL https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.sh | bash -s -- --full
#
# What it does:
#   1. Finds the newest published release (prereleases included -- GitHub's
#      /releases/latest skips them, and every JoyCreate release so far is a beta).
#   2. Downloads the installer zip for this OS plus SHA256SUMS.txt.
#   3. Refuses to continue if the checksum does not match.
#   4. Extracts it and runs the bundled installer, passing arguments through.
#
# This script only fetches and verifies. Installing is done by the same
# bootstrapper that ships in the zip, so there is one code path to maintain.
#
# Options handled here:  --version X.Y.Z   pick a specific release
# Everything else is passed to the bundled installer (--full, --no-companions,
# --silent, --skip-model, --appimage).

set -euo pipefail

REPO="${JOYCREATE_REPO:-DisciplesofLove/JoyCreate}"
VERSION=""
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done

c_cyan="\033[36m"; c_green="\033[32m"; c_red="\033[31m"; c_reset="\033[0m"
step() { printf "\n${c_cyan}==> %s${c_reset}\n" "$1"; }
fail() { printf "    ${c_red}XX${c_reset}  %s\n" "$1" >&2; exit 1; }

case "$(uname -s)" in
  Linux)  PLATFORM="Linux";  BOOTSTRAP="install-joycreate.sh" ;;
  Darwin) PLATFORM="macOS";  BOOTSTRAP="Install-JoyCreate.command" ;;
  *) fail "Unsupported OS: $(uname -s). On Windows, use install.ps1." ;;
esac

# macOS ships separate arm64 and x64 builds; pick the one for this CPU.
case "$(uname -m)" in
  x86_64|amd64)  ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) fail "Unsupported CPU architecture: $(uname -m)." ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required."

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else fail "Neither sha256sum nor shasum is available, so the download cannot be verified."
  fi
}

extract_zip() {
  # The zip is built on whichever CI runner produced it. unzip is not on every
  # minimal image, so fall back through the tools that usually are.
  if command -v unzip >/dev/null 2>&1; then unzip -q "$1" -d "$2"
  elif command -v bsdtar >/dev/null 2>&1; then mkdir -p "$2" && bsdtar -xf "$1" -C "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"
  else fail "Need unzip, bsdtar or python3 to extract the installer. e.g. sudo apt-get install -y unzip"
  fi
}

step "Looking up JoyCreate releases on github.com/$REPO..."
API_JSON="$(curl -fsSL -H "User-Agent: joycreate-web-installer" \
  "https://api.github.com/repos/$REPO/releases?per_page=30")" \
  || fail "Could not reach the GitHub API. If the repository is private, download the zip from the Releases page."

# Unauthenticated callers never see drafts, and the API lists newest first, so
# the first matching download URL is the newest published release. Matching on
# URLs avoids needing jq on the user's machine.
URLS="$(printf '%s' "$API_JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"$/\1/')"

if [ -n "$VERSION" ]; then
  TAG="v${VERSION#v}"
  ZIP_URL="$(printf '%s\n' "$URLS" | grep "/releases/download/$TAG/JoyCreate-Installer-$PLATFORM-$ARCH-[^/]*\.zip$" | head -n1 || true)"
  [ -n "$ZIP_URL" ] || fail "Release $TAG has no JoyCreate-Installer-$PLATFORM-$ARCH zip."
else
  ZIP_URL="$(printf '%s\n' "$URLS" | grep "/JoyCreate-Installer-$PLATFORM-$ARCH-[^/]*\.zip$" | head -n1 || true)"
  [ -n "$ZIP_URL" ] || fail "No published release has a JoyCreate-Installer-$PLATFORM-$ARCH zip."
  TAG="$(printf '%s' "$ZIP_URL" | sed 's#.*/releases/download/\([^/]*\)/.*#\1#')"
fi

# The checksum file must come from the same release as the zip.
SUMS_URL="$(printf '%s\n' "$URLS" | grep "/releases/download/$TAG/SHA256SUMS.txt$" | head -n1 || true)"
[ -n "$SUMS_URL" ] || fail "Release $TAG has no SHA256SUMS.txt, so the download cannot be verified. Aborting."

ZIP_NAME="$(basename "$ZIP_URL")"
echo "    Release: $TAG"

WORK="$(mktemp -d 2>/dev/null || mktemp -d -t joycreate)"
trap 'rm -rf "$WORK"' EXIT

step "Downloading $ZIP_NAME..."
curl -fL --progress-bar -o "$WORK/$ZIP_NAME" "$ZIP_URL"
curl -fsSL -o "$WORK/SHA256SUMS.txt" "$SUMS_URL"

step "Verifying checksum..."
# Exact string comparison on the name field, not a regex: a file name full of
# dots makes a poor pattern. A leading "*" marks binary mode in sha256sum output.
EXPECTED="$(awk -v f="$ZIP_NAME" '{ n = $2; sub(/^\*/, "", n); if (n == f) { print tolower($1); exit } }' "$WORK/SHA256SUMS.txt")"
[ -n "$EXPECTED" ] || fail "SHA256SUMS.txt has no entry for $ZIP_NAME. Aborting."
ACTUAL="$(sha256_of "$WORK/$ZIP_NAME")"
if [ "$EXPECTED" != "$ACTUAL" ]; then
  printf "      expected %s\n      actual   %s\n" "$EXPECTED" "$ACTUAL" >&2
  fail "Checksum mismatch -- the download is corrupt or has been tampered with."
fi
printf "    ${c_green}OK${c_reset}  sha256 %s\n" "$ACTUAL"

step "Extracting..."
extract_zip "$WORK/$ZIP_NAME" "$WORK/installer"

SCRIPT="$(find "$WORK/installer" -name "$BOOTSTRAP" -type f | head -n1)"
[ -n "$SCRIPT" ] || fail "$BOOTSTRAP is missing from the zip."

# A zip made on a Windows runner carries no execute bits. Restore them for
# everything the bootstrapper may run, including an AppImage.
find "$WORK/installer" -type f \( -name '*.sh' -o -name '*.command' -o -name '*.AppImage' \) -exec chmod +x {} +

# Piped from curl, this script's stdin is the script itself, so prompts in the
# bootstrapper would read garbage. Give it the terminal back when there is one.
if [ -e /dev/tty ] && [ -r /dev/tty ]; then
  bash "$SCRIPT" ${PASS[@]+"${PASS[@]}"} < /dev/tty
else
  bash "$SCRIPT" ${PASS[@]+"${PASS[@]}"}
fi
