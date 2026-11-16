# Builds dist\QuickTooth-Setup-<version>.exe: publishes QuickTooth as one native exe (Native AOT,
# no .NET runtime needed on the user's PC) and wraps it with Inno Setup 6.7+.
#   winget install JRSoftware.InnoSetup     # once, for ISCC.exe
#   .\installer\build.ps1
# Native AOT needs the MSVC linker: Visual Studio (or Build Tools) with "Desktop development with C++".
$ErrorActionPreference = 'Stop'
$root    = Split-Path $PSScriptRoot
$project = Join-Path $root 'src\QuickTooth\QuickTooth.csproj'
$stage   = Join-Path $PSScriptRoot 'obj\app'

$version = ([xml](Get-Content $project)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
if (-not $version) { throw "no <Version> in $project" }

$iscc = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source
    Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
    Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) { throw 'ISCC.exe not found. Install Inno Setup: winget install JRSoftware.InnoSetup' }

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
dotnet publish $project -c Release -r win-x64 -nologo -o $stage
if ($LASTEXITCODE -ne 0) { throw 'publish failed' }
Get-ChildItem $stage -Filter *.pdb | Remove-Item   # debug symbols stay out of the installer

& $iscc /Qp "/DAppVersion=$version" "/DAppSource=$stage" (Join-Path $PSScriptRoot 'QuickTooth.iss')
if ($LASTEXITCODE -ne 0) { throw 'ISCC failed' }

$setup = Get-Item (Join-Path $root "dist\QuickTooth-Setup-$version.exe")
Write-Host ("Built {0} ({1:N1} MB)" -f $setup.FullName, ($setup.Length / 1e6))
