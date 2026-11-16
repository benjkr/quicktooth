# Builds QuickTooth (one native exe, Native AOT) and installs it to %LOCALAPPDATA%\Programs\QuickTooth.
# A running copy is asked to exit first, because a running exe can't be overwritten.
# Native AOT needs the MSVC linker: Visual Studio (or Build Tools) with "Desktop development with C++".
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\QuickTooth'
$exe  = Join-Path $dest 'QuickTooth.exe'

$running = Get-Process QuickTooth -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
if ($running) {
    Start-Process -FilePath $exe -ArgumentList '--exit' -Wait
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Get-Process QuickTooth -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
}

$stage = Join-Path $PSScriptRoot 'src\QuickTooth\bin\publish'
dotnet publish "$PSScriptRoot\src\QuickTooth\QuickTooth.csproj" -c Release -r win-x64 -o $stage -nologo
if ($LASTEXITCODE -ne 0) { throw "publish failed" }
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item (Join-Path $stage 'QuickTooth.exe') $exe -Force
# Leftovers from 1.0.x builds, which bundled the .NET runtime and WPF next to the exe.
Get-ChildItem $dest -Filter '*_cor3.dll' -ErrorAction SilentlyContinue | Remove-Item -Force

if (-not $NoStart) { Start-Process -FilePath $exe }
Write-Host "Installed to $exe"
