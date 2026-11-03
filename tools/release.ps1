<#
.SYNOPSIS
    Builds the Dataverse solution package and publishes it as a GitHub Release
    asset using the locally authenticated GitHub CLI.

.DESCRIPTION
    Derived from the tag, e.g. v1.2.3 -> solution version 1.2.3.0 and
    artifacts/DataverseIDE_1.2.3.0.zip. Runs npm run build (unless -SkipBuild),
    npm run package:solution, writes a SHA256SUMS.txt next to the zip, pushes the
    tag if it is not on origin yet, and attaches both files to the release.

    One-time setup: gh auth login

.EXAMPLE
    .\tools\release.ps1 -Tag v1.0.0

.EXAMPLE
    .\tools\release.ps1 -Tag v1.1.0 -SkipBuild -NotesFile notes.md -Draft
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Tag,

    [string]$Solution = "DataverseIDE",
    [string]$Prefix = "dv_ide",
    [string]$NotesFile,
    [switch]$SkipBuild,
    [switch]$Draft,
    [switch]$Prerelease,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Fail([string]$Message) {
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

# Native tools write progress/warnings to stderr; with EAP=Stop PowerShell 5.1
# turns that into a terminating NativeCommandError, so run them with Continue.
function Invoke-Gh {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GhArgs)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $gh @GhArgs
    } finally {
        $ErrorActionPreference = $previous
    }
}

# --- tooling -----------------------------------------------------------------

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $gh = "C:\Program Files\GitHub CLI\gh.exe"
    if (-not (Test-Path $gh)) {
        Fail "GitHub CLI not found. Install it with: winget install --id GitHub.cli -e"
    }
}

$repo = (git remote get-url origin) -replace "^https://github.com/", "" -replace "\.git$", ""
if (-not $repo) { Fail "Could not determine the GitHub repo from origin." }

Invoke-Gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "Not signed in to GitHub. Run: gh auth login"
}

# --- tag/version -------------------------------------------------------------

$version = $Tag -replace "^v", ""
if ($version -match "^\d+\.\d+\.\d+$") {
    $version = "$version.0"
} elseif ($version -notmatch "^\d+\.\d+\.\d+\.\d+$") {
    Fail "Tag '$Tag' must look like v1.2.3 or v1.2.3.4 (solution versions have four parts)."
}

if (-not $AllowDirty) {
    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0) {
        $dirty | ForEach-Object { Write-Host "  $_" }
        Fail "Working tree is not clean. Commit or pass -AllowDirty to release uncommitted sources."
    }
}

if (-not (git rev-parse -q --verify "refs/tags/$Tag")) {
    Fail "Tag '$Tag' does not exist. Create it first: git tag -a $Tag -m '$Solution $Tag'"
}

if (-not (git ls-remote --tags origin "refs/tags/$Tag")) {
    Write-Host "Pushing tag $Tag to origin..."
    git push origin "refs/tags/$Tag"
    if ($LASTEXITCODE -ne 0) { Fail "git push origin refs/tags/$Tag failed." }
}

# --- build + package ---------------------------------------------------------

if (-not $SkipBuild) {
    Write-Host "Building..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "npm run build failed." }
}

Write-Host "Packaging ${Solution} $version..."
npm run package:solution -- --solution=$Solution --prefix=$Prefix --version=$version
if ($LASTEXITCODE -ne 0) { Fail "npm run package:solution failed." }

$zip = Get-ChildItem artifacts -Filter "${Solution}_${version}.zip" | Select-Object -First 1
if (-not $zip) { Fail "Package not found: artifacts/${Solution}_${version}.zip" }

$hash = (Get-FileHash $zip.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$checksum = Join-Path $zip.Directory "SHA256SUMS.txt"
"$hash  $($zip.Name)" | Set-Content -Path $checksum -Encoding ascii

Write-Host "Zip:    $($zip.FullName) ($([math]::Round($zip.Length / 1MB, 2)) MiB)"
Write-Host "SHA256: $hash"

# --- release -----------------------------------------------------------------

$files = @($zip.FullName, $checksum)
if ($NotesFile) {
    if (-not (Test-Path $NotesFile)) { Fail "Notes file not found: $NotesFile" }
    $notesArgs = @("--notes-file", (Resolve-Path $NotesFile).Path)
} else {
    $notesArgs = @("--generate-notes")
}
if ($Draft) { $notesArgs += "--draft" }
if ($Prerelease) { $notesArgs += "--prerelease" }

Invoke-Gh release view $Tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Release $Tag exists; uploading assets with --clobber..."
    Invoke-Gh release upload $Tag @files --repo $repo --clobber
    if ($LASTEXITCODE -ne 0) { Fail "gh release upload failed." }
} else {
    Write-Host "Creating release $Tag..."
    Invoke-Gh release create $Tag @files --repo $repo --verify-tag --title "${Solution} ${Tag}" @notesArgs
    if ($LASTEXITCODE -ne 0) { Fail "gh release create failed." }
}

$url = Invoke-Gh release view $Tag --repo $repo --json url --jq .url
Write-Host ""
Write-Host "Release: $url"
