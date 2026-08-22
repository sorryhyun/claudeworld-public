<#
.SYNOPSIS
    ClaudeWorld installer for Windows.

.DESCRIPTION
    Downloads the standalone ClaudeWorld.exe from the latest GitHub release,
    installs it under %LOCALAPPDATA%\ClaudeWorld, and adds Start Menu / Desktop
    shortcuts. Re-running upgrades in place and keeps your .env, database,
    agents and worlds - they all live next to the exe.

    The exe is one file: the backend, the built frontend and the default agents
    and prompts are all inside it. On first launch it unpacks the editable parts
    (agents\, backend\sdk\config\) beside itself, asks for a password, then
    serves the app on localhost and opens your browser at it.

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

$exeAsset = $release.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
if (-not $exeAsset) {
    Write-Fail "Release $tag has no Windows executable. Pick a newer release with -Version, or use the source install (install.sh) under WSL."
}

# Published beside the binaries by release.yml. It travels the same HTTPS
# channel they do, so it is no defence against a compromised release - it
# catches a truncated download and a stale CDN copy. Releases cut before it
# existed have none, so a missing manifest warns rather than fails.
$sumsAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1

# ------------------------------------------------------------------ download

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("claudeworld-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    $exeTemp = Join-Path $tempDir 'ClaudeWorld.exe'

    Write-Step "Downloading $($exeAsset.name) ($([math]::Round($exeAsset.size / 1MB, 1)) MB)"
    # Invoke-WebRequest redraws its progress bar on every response chunk, which
    # throttles a 100 MB download by an order of magnitude. Silencing it is the
    # single biggest speedup here.
    $previousProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $exeAsset.browser_download_url -OutFile $exeTemp -Headers $headers
    } finally {
        $ProgressPreference = $previousProgress
    }

    if ($sumsAsset) {
        Write-Step "Verifying checksum"
        $sumsTemp = Join-Path $tempDir 'SHA256SUMS'
        Invoke-WebRequest -Uri $sumsAsset.browser_download_url -OutFile $sumsTemp -Headers $headers

        # sha256sum writes "<hash>  <name>", the name possibly prefixed with a
        # `*` binary marker. Anchor on the name so one asset cannot match
        # another's suffix.
        $pattern = "\s\*?$([regex]::Escape($exeAsset.name))$"
        $line = Get-Content $sumsTemp | Where-Object { $_ -match $pattern } | Select-Object -First 1
        if (-not $line) {
            Write-Warn "No published checksum for $($exeAsset.name) - skipping verification."
        } else {
            $want = (($line -split '\s+')[0]).ToLowerInvariant()
            $have = (Get-FileHash -Path $exeTemp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($want -ne $have) {
                Write-Fail "Checksum mismatch: expected $want, got $have. Download aborted."
            }
            Write-Info "SHA256 matches"
        }
    } else {
        Write-Warn "This release publishes no SHA256SUMS - skipping verification."
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

    # The exe carries the default agents and prompts inside it and unpacks them
    # next to itself on launch. Files you have edited are left alone; ones you
    # never touched are moved forward to this release. See
    # backend/src/exe/assets.ts.
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
# ClaudeWorld spawns the Claude Code CLI for every agent turn. It is NOT inside
# the exe - the CLI binary is ~330 MB per platform, several times the size of
# everything else - so it has to be on this machine already. ClaudeWorld looks
# for it beside itself, then in ~\.local\bin, then on PATH.
if ((Get-Command claude -ErrorAction SilentlyContinue) -or
    (Test-Path (Join-Path $HOME '.local\bin\claude.exe'))) {
    Write-Info "claude CLI found"
} else {
    Write-Warn "The 'claude' CLI was not found. ClaudeWorld drives agents through it."
    Write-Warn "Install it before creating a world:"
    Write-Warn "  irm https://claude.ai/install.ps1 | iex"
    Write-Warn "Or set CLAUDE_API_KEY in $InstallDir\.env to use the API directly."
}

Write-Step "Done"
Write-Info "Installed $tag to $InstallDir"
Write-Host ""
Write-Info "Start it from the Start Menu, or run:  $exePath"
Write-Info "It asks for a password on first launch, then opens the app in your browser."
Write-Host ""
