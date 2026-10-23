<#
.SYNOPSIS
    Uploads the built dist/ output as Dataverse web resources and publishes them.

.DESCRIPTION
    Every file under dist/ is uploaded as a web resource named
    "<prefix>/<relative path>", e.g. dist/assets/index-xyz.js ->
    "dv_/ide/assets/index-xyz.js" served at:

      https://<org>.crm.dynamics.com/webresources/dv_/ide/assets/index-xyz.js

    Wasm/font binaries are already inlined into the JS chunks by the build
    config, so only .js/.json/.css/.html/.txt files end up being deployed.

    To create/update without publishing:  -Publish:$false
.EXAMPLE
    # Manual token (az CLI is the simple way):
    $token = (az account get-access-token --resource 00000007-0000-0000-c000-000000000000 --query accessToken -o tsv)
    .\tools\deploy-webresources.ps1 -EnvironmentUrl "https://myorg.crm4.dynamics.com" -Token $token
#>
param(
    [Parameter(Mandatory)][string] $EnvironmentUrl,
    [Parameter(Mandatory)][string] $Token,
    [string] $DistFolder = (Join-Path $PSScriptRoot "..\dist"),
    [string] $Prefix = "dv_/ide"
)

$ErrorActionPreference = 'Stop'
$EnvironmentUrl = $EnvironmentUrl.TrimEnd('/')

# WebResource.OptionSetType values
$TypeMap = [ordered]@{
    htm = 1; html = 1
    css = 2
    js = 3  # js / json / any data fetched at runtime is uploaded as Script type
    jsx = 3
    png = 4; jpg = 5; jpeg = 5; gif = 6; ico = 7
}

function Invoke-VsApi {
    param([string] $Method, [string] $Path, $Body, [hashtable] $Headers = @{})
    $uri = "$EnvironmentUrl/api/data/v9.2$Path"
    $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 6 -Compress } else { $null }
    $response = Invoke-RestMethod -Method $Method -Uri $uri -Headers (@{
        Authorization = "Bearer $Token"
        'OData-MaxVersion' = '4.0'
        'OData-Version' = '4.0'
        Accept = 'application/json'
    } + $Headers) -Body $json -ContentType 'application/json; charset=utf-8'
    return $response
}

if (-not (Test-Path $DistFolder)) { throw "dist folder not found: $DistFolder" }

# Skip source maps: .map is not a supported web resource file extension, and
# the vendor bundles are minified anyway (build has sourcemap: false). Skipping
# them halves the deploy payload (~50 MB of maps) and avoids 404s - browsers only
# request them when devtools is open.
$files = Get-ChildItem -Path $DistFolder -Recurse -File | Where-Object { $_.Extension -ne '.map' }
if (-not $files) { throw "dist folder is empty: $DistFolder" }

# Build the (possibly batched) set of upserts
$uploaded = 0
$failed = 0
foreach ($file in $files) {
    $relative = [System.IO.Path]::GetRelativePath($DistFolder, $file.FullName).Replace('\', '/')
    $name = "$Prefix/$relative"  # e.g. dv_/ide/assets/index-xyz.js
    $ext = $file.Extension.Substring(1).ToLowerInvariant()
    $type = if ($TypeMap.Contains($ext)) { $TypeMap[$ext] } else { 3 }

    # look up existing record id by name (web resources have no name alternate key)
    $encoded = [uri]::EscapeDataString($name)
    $existing = Invoke-VsApi -Method Get -Path "/webresources?`$filter=name eq '$encoded'&`$select=webresourceid,contentchecksum&`$top=1"

    $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))
    $payload = @{
        name           = $name
        displayname    = $relative
        description    = "Dataverse-IDE build ($([DateTime]::UtcNow.ToString('u')))"
        webresourcetype = $type
        content        = $content
    }

    try {
        if ($existing.value.Count -gt 0) {
            $id = $existing.value[0].webresourceid
            Invoke-VsApi -Method Patch "/webresources($id)" -Body $payload | Out-Null
            "UPDATE $name ($file.Length bytes)"
        } else {
            Invoke-VsApi -Method Post "/webresources" -Body $payload | Out-Null
            "CREATE $name ($file.Length bytes)"
        }
        $uploaded++
    } catch {
        $failed++
        Write-Warning "FAILED $name : $($_.Exception.Message)"
    }
}

# Publish changes so they take effect
try {
    Invoke-VsApi -Method Post "/PublishAllCustomizations" | Out-Null
    "Published all customizations"
} catch {
    Write-Warning "PublishAllCustomizations failed: $($_.Exception.Message)"
}

"DONE - uploaded: $uploaded, failed: $failed, total: $($files.Count)"
if ($failed -gt 0) { exit 1 }
