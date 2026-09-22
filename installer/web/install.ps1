# JoyCreate web installer for Windows -- the "one button" path.
#
#   irm https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.ps1 | iex
#
# With options (a piped `iex` cannot take parameters, so use a scriptblock):
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/DisciplesofLove/JoyCreate/main/installer/web/install.ps1))) -Full
#
# What it does:
#   1. Finds the newest published release (prereleases included -- every
#      JoyCreate release so far is a beta, and GitHub's /releases/latest
#      endpoint skips prereleases, so it would report "no release").
#   2. Downloads JoyCreate-Installer-Windows-*.zip and SHA256SUMS.txt.
#   3. Refuses to continue if the checksum does not match.
#   4. Extracts the zip and runs the bundled Install-JoyCreate.ps1, passing
#      through -Full / -NoCompanions / -Silent / -UseMsi / -SkipOllamaModel.
#
# One installer code path: this script only fetches and verifies. Everything
# that actually installs lives in Install-JoyCreate.ps1, which is the same file
# people get when they download the zip by hand.
#
# Works on Windows PowerShell 5.1, so no `??`, `?.` or ternaries below.

[CmdletBinding()]
param(
    [string]$Version,          # e.g. 0.32.0-beta.1. Default: newest release.
    [switch]$Full,
    [switch]$NoCompanions,
    [switch]$Silent,
    [switch]$UseMsi,
    [switch]$SkipOllamaModel,
    [string]$Repo = "DisciplesofLove/JoyCreate"
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 defaults to TLS 1.0, which GitHub rejects.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# The progress bar makes Invoke-WebRequest roughly 10x slower on 5.1.
$ProgressPreference = "SilentlyContinue"

function Write-Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Fail($m) { Write-Host "    XX  $m" -ForegroundColor Red }

$headers = @{ "User-Agent" = "joycreate-web-installer"; "Accept" = "application/vnd.github+json" }

Write-Step "Looking up JoyCreate releases on github.com/$Repo..."
try {
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers $headers
} catch {
    Write-Fail "Could not reach the GitHub API: $($_.Exception.Message)"
    Write-Host "    If the repository is private, download the installer zip from the Releases page instead."
    exit 1
}

$published = @($releases | Where-Object { -not $_.draft })
if ($Version) {
    $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
    $release = $published | Where-Object { $_.tag_name -eq $tag } | Select-Object -First 1
    if (-not $release) { Write-Fail "No published release tagged $tag."; exit 1 }
} else {
    $release = $published | Select-Object -First 1
    if (-not $release) { Write-Fail "No published releases found."; exit 1 }
}

$zipAsset  = $release.assets | Where-Object { $_.name -like "JoyCreate-Installer-Windows*.zip" } | Select-Object -First 1
$sumsAsset = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1
if (-not $zipAsset) {
    Write-Fail "Release $($release.tag_name) has no JoyCreate-Installer-Windows zip attached."
    exit 1
}
if (-not $sumsAsset) {
    # No checksum file means nothing to verify against. Installing an unverified
    # binary silently is exactly what a web installer must not do.
    Write-Fail "Release $($release.tag_name) has no SHA256SUMS.txt, so the download cannot be verified. Aborting."
    exit 1
}
Write-Host "    Release: $($release.tag_name)  ($([math]::Round($zipAsset.size / 1MB, 1)) MB)"

$work = Join-Path $env:TEMP ("joycreate-install-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zipPath  = Join-Path $work $zipAsset.name
$sumsPath = Join-Path $work "SHA256SUMS.txt"

Write-Step "Downloading $($zipAsset.name)..."
Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath  -Headers @{ "User-Agent" = "joycreate-web-installer" } -UseBasicParsing
Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsPath -Headers @{ "User-Agent" = "joycreate-web-installer" } -UseBasicParsing

Write-Step "Verifying checksum..."
$expectedLine = Get-Content $sumsPath | Where-Object { $_ -match ("\s\*?" + [regex]::Escape($zipAsset.name) + "$") } | Select-Object -First 1
if (-not $expectedLine) {
    Write-Fail "SHA256SUMS.txt has no entry for $($zipAsset.name). Aborting."
    exit 1
}
$expected = ($expectedLine -split "\s+")[0].ToLower()
$actual   = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
if ($expected -ne $actual) {
    Write-Fail "Checksum mismatch -- the download is corrupt or has been tampered with."
    Write-Host "      expected $expected"
    Write-Host "      actual   $actual"
    Remove-Item -Recurse -Force $work
    exit 1
}
Write-Host "    OK  sha256 $actual" -ForegroundColor Green

Write-Step "Extracting..."
$extract = Join-Path $work "installer"
Expand-Archive -Path $zipPath -DestinationPath $extract -Force

$bootstrap = Get-ChildItem -Path $extract -Filter "Install-JoyCreate.ps1" -Recurse | Select-Object -First 1
if (-not $bootstrap) { Write-Fail "Install-JoyCreate.ps1 is missing from the zip."; exit 1 }

# Files downloaded from the internet carry a Zone.Identifier stream that makes
# PowerShell prompt before running them. We just verified the hash ourselves.
Get-ChildItem -Path $extract -Recurse | Unblock-File

$passThrough = @{}
if ($Full)            { $passThrough.Full = $true }
if ($NoCompanions)    { $passThrough.NoCompanions = $true }
if ($Silent)          { $passThrough.Silent = $true }
if ($UseMsi)          { $passThrough.UseMsi = $true }
if ($SkipOllamaModel) { $passThrough.SkipOllamaModel = $true }

& $bootstrap.FullName @passThrough
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
exit $code
