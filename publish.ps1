# Builds QuickTooth and installs it to %LOCALAPPDATA%\Programs\QuickTooth (framework-dependent,
# single file). A running copy is asked to exit first, because a running exe can't be overwritten.
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\QuickTooth'
$exe  = Join-Path $dest 'QuickTooth.exe'

$running = Get-Process QuickTooth -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
if ($running) {
    & $exe --exit | Out-Null
    $running | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    Get-Process QuickTooth -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
}

dotnet publish "$PSScriptRoot\src\QuickTooth\QuickTooth.csproj" -c Release -r win-x64 --self-contained false `
    -p:PublishSingleFile=true -p:DebugType=none -o $dest -nologo
if ($LASTEXITCODE -ne 0) { throw "publish failed" }

if (-not $NoStart) { Start-Process -FilePath $exe }
Write-Host "Installed to $exe"
