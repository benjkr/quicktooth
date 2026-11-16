# Browser simulator (`sim/`)

Part of the specs (index in `AGENTS.md`). What it does now; the full command reference is
`sim/README.md`. Keep both current in the same change, and lean.

## What it is

- A copy of the Windows 11 taskbar in Playwright's bundled Chromium (never Chrome or Edge) with
  QuickTooth's icon, tooltip and menu. It's for seeing and testing changes without the real
  taskbar, including while the PC is locked.
- **Real**: the app's own code. `src/QuickTooth.Core` is compiled to WebAssembly by
  `src/QuickTooth.Web`: the renderer, `TrayController` and `Tunables`, so the same pixels, timers
  and log lines as the exe.
- **Simulated**: Windows' own drawing of the taskbar, tray, tooltip and menu (`web/shell.js`,
  `web/menu.js`, measured from real captures in `reference/`). Also Win32 timers on the 15.625 ms
  system tick (`SetTimer(83)` fires every 94.8 ms), the device worker (`web/tray.js`) and Bluetooth
  (`web/bluetooth.js`).

## How the page runs the C#

- `lib/core-build.mjs` rebuilds `src/QuickTooth.Web` into `sim/web/core` whenever the core's
  sources change; every launch prints `app core: …` with the build it uses. It needs the .NET 10
  SDK, with no workload.
- `web/core.js` loads it and supplies the `qt-host` imports. Each app instance gets its own JS
  host object (`TrayAppModel` in `web/tray.js`), so after `qt.restartApp()` the old app's leftover
  work still lands on its own stopped timers.
- `InlineContext` (C#) runs await continuations as soon as the awaited JS promise settles. Without
  it, .NET resumes them a browser turn later, after the virtual clock has moved on.
- One virtual clock drives everything: manual mode for agents (deterministic, seeded RNG), real
  time for recordings. A screenshot at t shows exactly that moment.

## Mock Bluetooth

- Separate A2DP and HFP endpoints, the link that lingers after a disconnect, notifications, the
  KS one-shot, the BLE battery advert and Windows battery.
- Profiles calibrated on real logs: `fast`, `typical`, `real-world`, `slow` (needs the 8 s resend),
  `flaky` (first request lost), `unreachable` (20 s timeout), `rejected`, `long-linger`,
  `hfp-very-slow`.

## Commands (`cd sim; bun qt-sim.mjs …`)

- `shot`, `run <scenario>` (scripted flows with assertions and optional MP4/GIF), `frames`
  (an animation contact sheet; `--compare --tune Name=value` sets numbers side by side), `parity`,
  `menu-check`, `test` (all fidelity checks and scenarios), `open` (a window with a control panel).
- `--tune` overrides any `Tunables.cs` value by name. JavaScript animation sketches (`--variant`)
  are gone: looks are changed in `IconRenderer.cs`.
