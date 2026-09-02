<#
.SYNOPSIS
    Builds Dataverse Model Designer and copies the single tool assembly into XrmToolBox.

.DESCRIPTION
    Only Oliver4.DataverseModelDesigner.dll is copied. The build output folder also contains the
    Dataverse SDK, WebView2, Newtonsoft.Json and the DockPanelSuite assemblies pulled in by
    XrmToolBoxPackage - XrmToolBox already ships all of those, and copying its own dependencies
    over the top is the usual cause of a tool that silently fails to load.

.PARAMETER Configuration
    Debug (default) or Release.

.PARAMETER PluginsPath
    Override the XrmToolBox Plugins folder. Defaults to the per-user installation path, and falls
    back to a portable install next to XrmToolBox.exe if that is where you run it from.

.EXAMPLE
    .\deploy.ps1
    .\deploy.ps1 -Configuration Release
    .\deploy.ps1 -PluginsPath 'D:\Tools\XrmToolBox\Plugins'
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',

    [string]$PluginsPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root 'src\Oliver4.DataverseModelDesigner\Oliver4.DataverseModelDesigner.csproj'

if (-not $PluginsPath) {
    $PluginsPath = Join-Path $env:APPDATA 'MscrmTools\XrmToolBox\Plugins'
}

if (Get-Process -Name 'XrmToolBox' -ErrorAction SilentlyContinue) {
    throw "XrmToolBox is running. Close it first - it holds a lock on the plugin assemblies."
}

Write-Host "Building $Configuration..." -ForegroundColor Cyan
dotnet build $project -c $Configuration --nologo
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$assembly = Join-Path $root "src\Oliver4.DataverseModelDesigner\bin\$Configuration\Oliver4.DataverseModelDesigner.dll"
if (-not (Test-Path $assembly)) { throw "Build output not found at $assembly" }

if (-not (Test-Path $PluginsPath)) {
    Write-Host "Creating $PluginsPath" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $PluginsPath -Force | Out-Null
}

Copy-Item $assembly -Destination $PluginsPath -Force

# The .pdb makes exception stack traces in the XrmToolBox log readable while developing.
$symbols = [System.IO.Path]::ChangeExtension($assembly, '.pdb')
if ($Configuration -eq 'Debug' -and (Test-Path $symbols)) {
    Copy-Item $symbols -Destination $PluginsPath -Force
}

Write-Host "Deployed to $PluginsPath" -ForegroundColor Green
Write-Host "Start XrmToolBox and look for 'Dataverse Model Designer' in the tool list." -ForegroundColor Green
