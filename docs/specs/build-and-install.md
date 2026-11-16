# Build, install and release

Part of the specs (index in `AGENTS.md`). What it does now. Keep it current in the same change,
and lean.

## The build

- One Native AOT exe for win-x64, about 5.3 MB. It needs no .NET runtime and no VC++
  redistributable: it imports only Windows DLLs and the universal CRT. Built with
  `OptimizationPreference=Size`, invariant globalization and English-only resources.
- Building needs the .NET 10 SDK and Visual Studio's C++ build tools (for the native linker).
  `dotnet build src/QuickTooth -c Release` makes a JIT build without installing anything.
- **Runtime patch pin**: `src/Directory.Build.targets` raises the .NET runtime pack, the browser
  (Mono) runtime pack and the AOT compiler pack to at least `QtRuntimePatch` (10.0.15, the fix for
  CVE-2026-111497). A newer SDK's own newer patch is left alone.
- The version is `<Version>` in `src/QuickTooth/QuickTooth.csproj`; the installer reads it.

## Installing

- `publish.ps1`: publishes natively to `src/QuickTooth/bin/publish`, asks the running tray to exit,
  copies the exe to `%LOCALAPPDATA%\Programs\QuickTooth`, removes files left by 1.0 builds and
  starts it.
- `installer/build.ps1` builds `dist/QuickTooth-Setup-<Version>.exe` with Inno Setup 6.7+
  (`winget install JRSoftware.InnoSetup`).
  - Per-user, no admin prompt. It closes the running tray first (`--exit`, then terminates it
    after 10 s).
  - Start with Windows is offered, and ticked, on a fresh install only; an update leaves the user's
    setting as it was.
  - Uninstalling removes the app, its folder, the Start menu entry and the autostart value, and
    keeps `%APPDATA%\QuickTooth`.
  - Unsigned, so Windows SmartScreen warns on download.
- **What goes on the user's PC**: only builds of `main`, from a release tag once tags exist; never a
  branch or PR build. Say which commit or tag is installed.

## Before a public release

- The README's icon credit must name the artwork's author (Alex Martynov), its CC Attribution
  licence, and say it was modified.
- Never ship `dist/QuickTooth-Setup-1.0.0.exe`: it bundles an unpatched runtime.
