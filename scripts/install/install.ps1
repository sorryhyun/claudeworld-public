<#
.SYNOPSIS
    ClaudeWorld installer for Windows.

.DESCRIPTION
    Downloads the standalone ClaudeWorld.exe from the latest GitHub release,
    installs it under %LOCALAPPDATA%\ClaudeWorld, and adds Start Menu / Desktop
    shortcuts. Re-running upgrades in place and keeps your .env, database,
    agents and worlds - they all live next to the exe.

    One-liner:
      irm https://github.com/sorryhyun/claudeworld-public/releases/latest/download/install.ps1 | iex

    With options, download first:
      irm <url> -OutFile install.ps1; .\install.ps1 -InstallDir D:\ClaudeWorld

.PARAMETER Version
    Release tag to install. Defaults to the latest published release.

.PARAMETER InstallDir
    Install location. Defaults to $env:LOCALAPPDATA\ClaudeWorld.

.PARAMETER Repo
    Source repository in owner/repo form.

.PARAMETER NoShortcut
    Skip creating Start Menu and Desktop shortcuts.

.PARAMETER NoPath
    Skip adding the install directory to the user PATH.
#>
[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$InstallDir = "$env:LOCALAPPDATA\ClaudeWorld",
    [string]$Repo = 'sorryhyun/claudeworld-public',
    [switch]$NoShortcut,
    [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Info { param([string]$Message) Write-Host "  $Message" }
function Write-Warn { param([string]$Message) Write-Host "  ! $Message" -ForegroundColor Yellow }
function Write-Fail { param([string]$Message) Write-Host "  x $Message" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------- release

Write-Step "Resolving release for $Repo"

$headers = @{ 'User-Agent' = 'claudeworld-installer' }
try {
    $apiUrl = if ($Version -eq 'latest') {
        "https://api.github.com/repos/$Repo/releases/latest"
    } else {
        "https://api.github.com/repos/$Repo/releases/tags/$Version"
    }
    $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers
} catch {
    Write-Fail "Could not reach the GitHub release API: $($_.Exception.Message)"
}

$tag = $release.tag_name
Write-Info "Version: $tag"

# Newer releases ship a bare ClaudeWorld.exe; older ones only the zip.
$exeAsset = $release.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
$zipAsset = $release.assets | Where-Object { $_.name -like '*Windows*.zip' } | Select-Object -First 1
if (-not $exeAsset -and -not $zipAsset) {
    Write-Fail "Release $tag has no Windows build. Pick another version with -Version. The Windows executable is not currently built - use the source install (install.sh) under WSL."
}

# ------------------------------------------------------------------ download

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("claudeworld-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    $exeTemp = Join-Path $tempDir 'ClaudeWorld.exe'

    if ($exeAsset) {
        Write-Step "Downloading $($exeAsset.name) ($([math]::Round($exeAsset.size / 1MB, 1)) MB)"
        Invoke-WebRequest -Uri $exeAsset.browser_download_url -OutFile $exeTemp -Headers $headers
    } else {
        Write-Step "Downloading $($zipAsset.name) ($([math]::Round($zipAsset.size / 1MB, 1)) MB)"
        $zipTemp = Join-Path $tempDir 'windows.zip'
        Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipTemp -Headers $headers

        $extractDir = Join-Path $tempDir 'extracted'
        Expand-Archive -Path $zipTemp -DestinationPath $extractDir -Force
        $found = Get-ChildItem -Path $extractDir -Filter '*.exe' -Recurse | Select-Object -First 1
        if (-not $found) { Write-Fail "No .exe inside $($zipAsset.name)." }
        Copy-Item $found.FullName $exeTemp -Force
    }

    # ----------------------------------------------------------------- install

    Write-Step "Installing to $InstallDir"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    $exePath = Join-Path $InstallDir 'ClaudeWorld.exe'
    if (Test-Path $exePath) {
        $running = Get-Process -Name 'ClaudeWorld' -ErrorAction SilentlyContinue
        if ($running) {
            Write-Fail "ClaudeWorld is currently running. Close it and re-run this installer."
        }
    }
    Copy-Item $exeTemp $exePath -Force
    Write-Info "ClaudeWorld.exe"

    # The exe carries the default agents inside it and unpacks them next to
    # itself on first launch, so an upgrade leaves your edited agents alone.
    Write-Info "Your .env, claudeworld.db, agents\ and worlds\ stay in $InstallDir"

    $tag | Set-Content -Path (Join-Path $InstallDir '.claudeworld-version') -Encoding ascii

    # --------------------------------------------------------------- shortcuts

    if (-not $NoShortcut) {
        Write-Step "Creating shortcuts"
        $shell = New-Object -ComObject WScript.Shell
        $targets = @(
            (Join-Path ([Environment]::GetFolderPath('Programs')) 'ClaudeWorld.lnk'),
            (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ClaudeWorld.lnk')
        )
        foreach ($linkPath in $targets) {
            $shortcut = $shell.CreateShortcut($linkPath)
            $shortcut.TargetPath = $exePath
            $shortcut.WorkingDirectory = $InstallDir
            $shortcut.Description = 'ClaudeWorld - AI-powered text adventure'
            $shortcut.Save()
            Write-Info "$(Split-Path $linkPath -Leaf) -> $(Split-Path $linkPath -Parent)"
        }
    }

    # -------------------------------------------------------------------- PATH

    if (-not $NoPath) {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath -notlike "*$InstallDir*") {
            Write-Step "Adding $InstallDir to your PATH"
            $newPath = if ([string]::IsNullOrEmpty($userPath)) { $InstallDir } else { "$userPath;$InstallDir" }
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
            Write-Info "Open a new terminal to pick it up."
        }
    }
} finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

# --------------------------------------------------------------- prerequisites

Write-Step "Checking AI provider"
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Info "claude CLI found"
} else {
    Write-Warn "The 'claude' CLI was not found. ClaudeWorld drives agents through it."
    Write-Warn "Install it before creating a world:"
    Write-Warn "  npm install -g @anthropic-ai/claude-code"
    Write-Warn "Or set CLAUDE_API_KEY in .env to use the API directly."
}

Write-Step "Done"
Write-Info "Installed $tag to $InstallDir"
Write-Host ""
Write-Info "Start it from the Start Menu, or run:  $exePath"
Write-Info "It sets up your password on first launch, then opens the app in a native window."
Write-Host ""
