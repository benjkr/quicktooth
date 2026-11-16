# QuickTooth — notes for agents

## Seeing and testing tray changes without the real taskbar

`sim/` is a browser simulator of the Windows 11 taskbar with QuickTooth's icon, tooltip, menu and
connect logic (ported from `TrayApp.cs` / `IconRenderer.cs`, constants read from the C#), with a
mocked Bluetooth stack whose delays are tunable. Use it to screenshot, record and assert UI and
behaviour — also when the PC is locked — and to try visual changes before writing the C#.

```powershell
cd sim; npm install                         # once
node qt-sim.mjs shot --zoom 8               # tray screenshot (+ 8× copy)
node qt-sim.mjs run demo-connect            # recorded flow → MP4/GIF in sim/out
node qt-sim.mjs frames --compare --tune Travel=2.4   # animation before/after
node qt-sim.mjs test                        # fidelity checks + behaviour scenarios
```

Full reference: `sim/README.md`. It uses Playwright's bundled Chromium only, not Chrome or Edge.

When you change `IconRenderer.cs` or `TrayApp.cs`, mirror it in `sim/web/icon.js` / `sim/web/tray.js`
and run `node qt-sim.mjs test` (`parity` compares the JS icon renderer with `QuickTooth.exe --render-icons`).

## Building

`dotnet build src/QuickTooth -c Release` builds without installing. `publish.ps1` installs to
`%LOCALAPPDATA%\Programs\QuickTooth` and restarts the running tray, so use it only when you mean to.
