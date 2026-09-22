# JoyCreate One-Click Installer (bootstrapper)
#
# This script runs on the END USER'S Windows machine.
# It is shipped inside JoyCreate-Installer.zip alongside the Setup.exe
# produced by `npm run make`.
#
# Responsibilities:
#   1. Install JoyCreate (silent Squirrel install).
#   2. Offer to install optional companions via winget:
#        - Ollama         (local LLMs)
#        - LibreOffice    (document export)
#        - Docker Desktop (n8n / Celestia / Postgres orchestration)
#   3. Pull a starter Ollama model if Ollama was installed.
#   4. Start n8n locally (npx) on first run if the user wants it.
#   5. Place a JoyCreate icon shortcut on the Desktop.
#
# Nothing here requires VS Code, Node.js, or git on the user's machine.
# Winget ships with Windows 10 1809+ and Windows 11 by default.

[CmdletBinding()]
param(
    [switch]$Silent,           # Skip all prompts, install JoyCreate only
    [switch]$Full,             # Skip prompts, install everything
    [switch]$NoCompanions,     # Skip prompts, JoyCreate only
    [switch]$SkipOllamaModel,  # Don't pull a starter model even if Ollama installed
    [switch]$UseMsi            # Install from the .msi instead of Setup.exe (IT / managed PCs)
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg)    { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg)   { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Write-Fail($msg)    { Write-Host "    XX  $msg" -ForegroundColor Red }

function Confirm-YesNo([string]$question, [bool]$defaultYes = $true) {
    if ($Silent -or $NoCompanions) { return $false }
    if ($Full) { return $true }
    $suffix = if ($defaultYes) { "[Y/n]" } else { "[y/N]" }
    $answer = Read-Host "$question $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $defaultYes }
    return $answer.Trim().ToLower().StartsWith("y")
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Invoke-Winget {
    param([string]$id, [string]$friendly)
    if (-not (Test-Command winget)) {
        Write-Fail "winget not found. Install '$friendly' manually from the publisher's website."
        return $false
    }
    Write-Host "    Installing $friendly via winget (id: $id)..." -ForegroundColor DarkGray
    & winget install --id $id --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "$friendly installed."
        return $true
    }
    # winget exit code 0x8A150061 = "no applicable update found" -> already installed
    if ($LASTEXITCODE -eq -1978335135) {
        Write-Ok "$friendly is already installed."
        return $true
    }
    Write-Warn2 "$friendly install returned exit code $LASTEXITCODE. You may need to install it manually."
    return $false
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
Clear-Host
Write-Host ""
Write-Host "  =====================================================" -ForegroundColor Magenta
Write-Host "         JoyCreate - One Click Installer" -ForegroundColor Magenta
Write-Host "  =====================================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "  This will install:"
Write-Host "    - JoyCreate desktop app (required)"
Write-Host "    - Ollama         (optional, local AI models)"
Write-Host "    - LibreOffice    (optional, document export)"
Write-Host "    - Docker Desktop (optional, for n8n / Celestia)"
Write-Host ""

# ---------------------------------------------------------------------------
# 1. Install JoyCreate (Squirrel Setup.exe)
# ---------------------------------------------------------------------------
Write-Step "Installing JoyCreate..."

$setupExe = Get-ChildItem -Path $scriptRoot -Filter "*Setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$msiFile  = Get-ChildItem -Path $scriptRoot -Filter "*.msi"       -ErrorAction SilentlyContinue | Select-Object -First 1

if ($UseMsi -and -not $msiFile) {
    Write-Fail "-UseMsi was given but no .msi file is next to this script."
    exit 1
}
if (-not $setupExe -and -not $msiFile) {
    Write-Fail "Could not find JoyCreate Setup.exe or .msi next to this script."
    Write-Host "    Expected something like: joycreate-0.32.0-beta.1.Setup.exe in $scriptRoot"
    exit 1
}

# Both installers are GUI-subsystem programs. Invoking one with `&` returns
# immediately without waiting, and leaves $LASTEXITCODE holding whatever ran
# before it -- so the old version reported "installed" for installs that were
# still running, or that had failed. Start-Process -Wait is the only reliable
# way to get the real exit code.
if ($UseMsi -or -not $setupExe) {
    # The MSI installs for all users under Program Files. Run silently without
    # elevation, msiexec fails with 1603/1925 and no visible prompt, so check
    # up front and say what to do instead.
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Fail "The MSI installs for all users and needs an elevated PowerShell (right-click -> Run as administrator)."
        if ($setupExe) { Write-Host "    Or run without -UseMsi to install just for you, no admin needed." }
        exit 1
    }
    $msiLog = Join-Path $env:TEMP "JoyCreate-msi-install.log"
    Write-Host "    Installing $($msiFile.Name) (log: $msiLog)" -ForegroundColor DarkGray
    $proc = Start-Process -FilePath "msiexec.exe" -Wait -PassThru -ArgumentList @(
        "/i", "`"$($msiFile.FullName)`"", "/qn", "/norestart", "/l*v", "`"$msiLog`""
    )
    # 3010 = success, reboot required. Anything else non-zero is a failure.
    if ($proc.ExitCode -eq 3010) {
        Write-Warn2 "Installed, but Windows wants a restart before JoyCreate is fully usable."
    } elseif ($proc.ExitCode -ne 0) {
        Write-Fail "MSI install failed with exit code $($proc.ExitCode). See $msiLog"
        exit $proc.ExitCode
    }
} else {
    Write-Host "    Running $($setupExe.Name)" -ForegroundColor DarkGray
    $proc = Start-Process -FilePath $setupExe.FullName -ArgumentList "--silent" -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
        Write-Fail "Setup.exe failed with exit code $($proc.ExitCode)."
        Write-Host "    Squirrel writes its log to: $env:LOCALAPPDATA\SquirrelTemp\SquirrelSetup.log"
        exit $proc.ExitCode
    }
}

# Setup.exe installs per-user under %LOCALAPPDATA%\joycreate; the MSI may land
# elsewhere depending on how it was built. Look rather than assume, and do not
# claim success until the executable is actually on disk.
$candidates = @(
    (Join-Path $env:LOCALAPPDATA "joycreate\JoyCreate.exe"),
    (Join-Path $env:LOCALAPPDATA "JoyCreate\JoyCreate.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\JoyCreate\JoyCreate.exe"),
    (Join-Path $env:ProgramFiles "JoyCreate\JoyCreate.exe")
)
$joyExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $joyExe) {
    Write-Fail "The installer exited cleanly, but JoyCreate.exe was not found in any expected location."
    $candidates | ForEach-Object { Write-Host "      checked: $_" }
    exit 1
}
$installRoot = Split-Path -Parent $joyExe
Write-Ok "JoyCreate installed at $installRoot"

# ---------------------------------------------------------------------------
# 2. Optional companions
# ---------------------------------------------------------------------------
$installOllama  = Confirm-YesNo "Install Ollama (local AI models, ~500MB)?"      $true
$installLibre   = Confirm-YesNo "Install LibreOffice (document export, ~300MB)?" $true
$installDocker  = Confirm-YesNo "Install Docker Desktop (for n8n / Celestia)?"   $false

if ($installOllama) {
    Write-Step "Installing Ollama..."
    $ok = Invoke-Winget -id "Ollama.Ollama" -friendly "Ollama"
    if ($ok -and -not $SkipOllamaModel) {
        if (Confirm-YesNo "Pull starter model 'llama3.2:3b' (~2GB)?" $true) {
            Write-Step "Pulling llama3.2:3b (this can take a while)..."
            $ollamaCmd = Get-Command ollama -ErrorAction SilentlyContinue
            if (-not $ollamaCmd) {
                $ollamaCmd = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
            } else {
                $ollamaCmd = $ollamaCmd.Source
            }
            if (Test-Path $ollamaCmd) {
                & $ollamaCmd pull llama3.2:3b
                Write-Ok "Model ready."
            } else {
                Write-Warn2 "ollama.exe not on PATH yet. Open a new terminal and run: ollama pull llama3.2:3b"
            }
        }
    }
}

if ($installLibre) {
    Write-Step "Installing LibreOffice..."
    Invoke-Winget -id "TheDocumentFoundation.LibreOffice" -friendly "LibreOffice"
}

if ($installDocker) {
    Write-Step "Installing Docker Desktop..."
    Invoke-Winget -id "Docker.DockerDesktop" -friendly "Docker Desktop"
    Write-Warn2 "Docker Desktop usually requires a reboot before first use."
}

# ---------------------------------------------------------------------------
# 3. Desktop shortcut with JoyCreate icon
# ---------------------------------------------------------------------------
Write-Step "Creating Desktop shortcut..."
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "JoyCreate.lnk"
$iconPath = Join-Path $installRoot "resources\app.asar.unpacked\assets\icon\logo.ico"

try {
    $wsh = New-Object -ComObject WScript.Shell
    $sc  = $wsh.CreateShortcut($lnkPath)
    $sc.TargetPath = $joyExe
    $sc.WorkingDirectory = $installRoot
    if (Test-Path $iconPath) { $sc.IconLocation = "$iconPath,0" }
    $sc.Description = "JoyCreate - AI app builder"
    $sc.Save()
    Write-Ok "Desktop shortcut created."
} catch {
    Write-Warn2 "Could not create Desktop shortcut: $_"
}

# ---------------------------------------------------------------------------
# 4. Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "  =====================================================" -ForegroundColor Green
Write-Host "    All done. Launching JoyCreate..." -ForegroundColor Green
Write-Host "  =====================================================" -ForegroundColor Green
Write-Host ""

if (Test-Path $joyExe) {
    Start-Process $joyExe
} else {
    Write-Warn2 "JoyCreate.exe not found at $joyExe. Open the Start menu and search 'JoyCreate'."
}

if (-not $Silent) {
    Write-Host ""
    Read-Host "Press Enter to close this installer"
}
