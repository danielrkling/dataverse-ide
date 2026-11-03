<#
.SYNOPSIS
    Publishes the built app to GitHub Pages from this machine.

.DESCRIPTION
    Runs npm run build (unless -SkipBuild), then force-pushes dist/ as the root
    of the gh-pages branch. The branch history is replaced on every deploy, so
    the repository only ever carries one copy of the build. Pages is enabled
    automatically (branch gh-pages, path /) the first time.

    A .nojekyll file is required: GitHub Pages runs Jekyll by default, and
    Jekyll drops files whose names start with "_" - Vite emits several such
    chunks (_commonjsHelpers-*.js, ...), and the IDE breaks without them.

    The service worker at <site>/sw.js adds the COOP/COEP headers the IDE needs,
    so the public demo has the same two-phase load as the Dataverse deployment:
    first load is not cross-origin isolated, the reload after the worker takes
    control is.

.EXAMPLE
    .\tools\deploy-pages.ps1

.EXAMPLE
    .\tools\deploy-pages.ps1 -SkipBuild
#>
param(
    [switch]$SkipBuild,
    [string]$Branch = "gh-pages"
)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Fail([string]$Message) {
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

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

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $gh = "C:\Program Files\GitHub CLI\gh.exe"
    if (-not (Test-Path $gh)) {
        Fail "GitHub CLI not found. Install it with: winget install --id GitHub.cli -e"
    }
}

$remoteUrl = git remote get-url origin
$repo = $remoteUrl -replace "^https://github.com/", "" -replace "\.git$", ""
if (-not $repo) { Fail "Could not determine the GitHub repo from origin." }

if (-not $SkipBuild) {
    Write-Host "Building..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "npm run build failed." }
}

if (-not (Test-Path "dist/index.html")) {
    Fail "dist/index.html is missing (run without -SkipBuild)."
}

# Jekyll must be disabled: dist/assets contains _*.js chunks.
$noJekyll = Join-Path "dist" ".nojekyll"
if (-not (Test-Path $noJekyll)) {
    New-Item -ItemType File -Path $noJekyll | Out-Null
}

$sourceCommit = (git rev-parse --short HEAD)

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dv-ide-pages-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temp | Out-Null

try {
    git -C $temp init -q
    git -C $temp checkout -q -b $Branch
    Get-ChildItem dist -Force | Copy-Item -Destination $temp -Recurse -Force

    git -C $temp add -A
    git -C $temp commit -q -m "Deploy $sourceCommit"
    if ($LASTEXITCODE -ne 0) { Fail "git commit failed in the temporary deploy repo." }

    Write-Host "Pushing dist/ to origin/$Branch..."
    git -C $temp push --force --quiet $remoteUrl "HEAD:$Branch"
    if ($LASTEXITCODE -ne 0) { Fail "git push to $Branch failed." }
} finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}

# Enable Pages the first time; keep the branch source if it already exists.
Invoke-Gh api "repos/$repo/pages" *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Enabling GitHub Pages (branch $Branch)..."
    Invoke-Gh api "repos/$repo/pages" -X POST -f "source[branch]=$Branch" -f "source[path]=/" *> $null
    if ($LASTEXITCODE -ne 0) {
        Fail "Could not enable Pages. Enable it once in Settings -> Pages (source: $Branch / root), then re-run."
    }
} else {
    Invoke-Gh api "repos/$repo/pages" -X PUT -f "source[branch]=$Branch" -f "source[path]=/" *> $null
}

$owner = ($repo -split "/")[0]
$name = ($repo -split "/")[1]
$url = "https://$owner.github.io/$name/"

Write-Host "Waiting for $url ..."
$lastStatus = "no response"
for ($attempt = 0; $attempt -lt 36; $attempt += 1) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
        if ($response.StatusCode -eq 200 -and $response.Content -match "Dataverse IDE") {
            $lastStatus = "200 OK"
            break
        }
        $lastStatus = "HTTP $($response.StatusCode)"
    } catch {
        $lastStatus = $_.Exception.Message
    }
    Start-Sleep -Seconds 10
}

if ($lastStatus -ne "200 OK") {
    Fail "Pages did not come up yet ($lastStatus). Check Actions/build status in Settings -> Pages, then open $url"
}

Write-Host ""
Write-Host "Pages: $url"
