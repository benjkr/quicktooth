# QuickTooth — notes for agents

## One codebase, two hosts

The app's behaviour and looks live in **`src/QuickTooth.Core`** (no Windows APIs): the icon
renderer and animation (`IconRenderer.cs`), the tray state machine (`TrayController.cs`: connect,
link-teardown wait, resend, timeout, tooltip text, menu contents, battery), settings, and every
timing/animation number (`Tunables.cs`). It runs in two places:

- **The real app** (`src/QuickTooth`, Native AOT exe): `TrayApp.cs` hosts the core with a Win32
  window, Shell_NotifyIcon, SetTimer, TrackPopupMenu and HICONs; `WindowsDevices.cs` is the real
  Bluetooth (Core Audio / KS / BLE).
- **The browser simulator** (`sim/`): the same core compiled to WebAssembly (`src/QuickTooth.Web`)
  on a mock Windows 11 taskbar with a virtual clock and a tunable mock Bluetooth stack.

So build features and looks in `src/QuickTooth.Core`, try them in the simulator (screenshots,
recordings, scenarios — also while the PC is locked), then they ship in the exe unchanged. Only
Windows' own chrome (taskbar, menu and tooltip drawing) and the device layer are simulated.

## Seeing and testing tray changes without the real taskbar

```powershell
cd sim; npm install                         # once
node qt-sim.mjs shot --zoom 8               # tray screenshot (+ 8× copy)
node qt-sim.mjs run demo-connect            # recorded flow → MP4/GIF in sim/out
node qt-sim.mjs frames --compare --tune Travel=2.4   # animation, current numbers vs tuned
node qt-sim.mjs test                        # fidelity checks + behaviour scenarios
```

Every run rebuilds the browser build of the core first if the C# changed (`app core: …` line). It
needs the .NET 10 SDK (no workload). Full reference: `sim/README.md`. It uses Playwright's bundled
Chromium only, not Chrome or Edge.

After changing the core, run `node qt-sim.mjs test`. `parity` checks the browser build draws the
same pixels as `QuickTooth.exe --render-icons` (within 1 level). Changing `TrayApp.cs` or
`WindowsDevices.cs` (the Windows side) isn't covered by the simulator; test those on the real app.

## Building

`dotnet build src/QuickTooth -c Release` builds without installing. `publish.ps1` installs to
`%LOCALAPPDATA%\Programs\QuickTooth` and restarts the running tray, so use it only when you mean to.
`installer\build.ps1` builds `dist\QuickTooth-Setup-<version>.exe`. Native AOT needs Visual Studio's
C++ build tools. Read-only checks on the exe: `--list --all`, `--probe <id>`, `--render-icons <dir>`,
`--selftest-icons`, `--stress-enumerate N`, `--watch-endpoints S`.
