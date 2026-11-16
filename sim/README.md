# QuickTooth taskbar simulator

A browser copy of the Windows 11 taskbar with QuickTooth's tray icon in it. Use it to see and test
icon, animation, tooltip, menu and connect/disconnect behaviour without a real taskbar (for example
while the PC is locked), and to try changes before they reach the real taskbar.

- **The app code is the real code.** The icon renderer, the tray state machine (timers, link-teardown wait, resend, timeout, tooltip, menu contents, battery) and every tunable are the app's own C# from `src/QuickTooth.Core`, compiled to WebAssembly (`src/QuickTooth.Web`) and run in the page. The exe runs the same code on Windows. `web/tray.js` and `web/icon.js` are only the page-side host: Win32 timers on the virtual clock, the device worker, the mock shell and Bluetooth.
- **Bluetooth is mocked at the app's own seam**: `Enumerate`, `SendOneShot`, `BluetoothConnected`, endpoint notifications, the BLE battery scan. A2DP and HFP are separate, and the profiles are calibrated on the real `quicktooth.log` (fast / typical / real-world mix / slow / flaky / unreachable / …).
- **One virtual clock drives everything**, including fades and delays, so a screenshot at t = 1.234 s is exactly what the screen shows then, and recordings are frame-accurate.
- **Runs only in Playwright's bundled Chromium**, never Chrome or Edge. Pixels come out at the physical resolution for 100–200 % scaling.

## Setup

```powershell
cd sim
bun install            # playwright 1.60.0; uses its Chromium (revision 1223) — run `bunx playwright install chromium` if it's missing
bun qt-sim.mjs doctor  # shows the browser and ffmpeg in use
```

Needs Bun 1.4.4+ (older Bun hangs launching Chromium on Windows; `bun upgrade`), ffmpeg (for video, GIF and `--zoom`) and the .NET 10 SDK: every run first rebuilds the app's C# core for the browser if it changed (into `web/core`, about 5–10 s; prints which build it uses). No .NET workload is needed.

## Recipes

```powershell
# What does the tray look like right now? (physical pixels; @8x copy for pixel peeping)
bun qt-sim.mjs shot --zoom 8
bun qt-sim.mjs shot --connected --theme light --scale 1.5 --region icon --zoom 8

# Hover tooltip / right-click menu / submenu
bun qt-sim.mjs shot --hover icon --wait 700
bun qt-sim.mjs shot --rclick icon --wait 200 --hover "menu:Device" --wait 500

# Mid-animation: 400 ms into a connect on a slow headset
bun qt-sim.mjs shot --profile slow --click icon --wait 400 --region icon --zoom 8

# A whole flow as video (MP4 + GIF, real-time pace, frame-accurate) — see scenarios/demo-connect.json
bun qt-sim.mjs run demo-connect

# The same click on several connection profiles, side by side (what slow/flaky/failing looks like)
bun examples/compare-profiles.mjs fast typical slow unreachable

# Every animation phase, one frame per real timer tick, both themes (+ GIFs)
bun qt-sim.mjs frames --zoom 8

# Try different numbers (src/QuickTooth.Core/Tunables.cs) side by side with the current ones
bun qt-sim.mjs frames --compare --tune Travel=2.4,TracerPeriod=0.8
# A new look or behaviour: change src/QuickTooth.Core (e.g. IconRenderer.cs); the next run rebuilds it
bun qt-sim.mjs frames --zoom 8

# Does it still behave? (fidelity checks + all scenarios with assertions)
bun qt-sim.mjs test

# Click around yourself (window with a control panel: profiles, time controls, tunables, live log)
bun qt-sim.mjs open
```

Output goes to `sim/out/` (git-ignored). Every `run` writes the screenshots, `quicktooth.log` in the
real app's format, `timeline.json` (app, shell and Bluetooth events merged) and `final-state.json`.

## Commands

| Command | What it does |
| --- | --- |
| `shot [steps…]` | Opens the simulator, runs the steps in order, takes one screenshot. `--region tray\|screen\|taskbar\|icon\|x,y,w,h`, `--zoom N`, `--out file.png`, `--json` (prints the full state). |
| `run <scenario>` | Runs a scenario file (or a built-in name from `scenarios/`). Exit code 1 if an `expect` or `waitFor` fails. `--headed` to watch. |
| `frames` | Animation contact sheet + GIF per phase at the real timer cadence. `--phase`, `--size`, `--zoom`, `--compare` (current numbers vs your `--tune`). |
| `parity` | Builds the app, runs `QuickTooth.exe --render-icons`, diffs every icon and animation frame against the browser build of the same renderer. Must match within 1 level (maths-library rounding). `--no-build` uses the last build. |
| `menu-check` | Renders the menu and diffs it against real Win32 captures (`reference/menu`): sizes, item rects, placement, colours. |
| `test` | `parity` + `menu-check` + taskbar geometry vs UI Automation + pixel integrity at 100–200 % + every scenario that asserts something. |
| `open` | Headed window with a control panel (realtime clock). Default screen 1280×720. |

Step flags for `shot` (applied in the order given): `--hover T`, `--move T`, `--click T`, `--rclick T`,
`--wait ms`, `--key K`, `--cli --toggle`, `--bt fn,arg,…`, `--profile-step P`, `--theme-step T`,
`--scale-step S`, `--tune-step Name=value,…`. Targets: `icon`, `chevron`, `clock`, `menu:<label>`, `x,y` (physical px).

Simulator options (any command that opens it): `--scale 1|1.25|1.5|1.75|2`, `--screen 1920x1080`,
`--theme dark|light`, `--style solid|acrylic`, `--profile <name>`, `--seed N`, `--connected`,
`--first-run` (empty settings, icon starts in the overflow), `--overflow`, `--no-cursor`, `--no-dwm`,
`--timer-quantum 15.625` (0 = exact timers), `--tune Name=value,…` (or JSON; names from `src/QuickTooth.Core/Tunables.cs`), `--settle ms`.

## Scenarios

```json
{
  "name": "connect-fast",
  "options": { "profile": "fast", "theme": "dark", "scale": 1 },
  "region": "tray",
  "record": { "fps": 30, "zoom": 2 },
  "steps": [
    { "hover": "icon", "ms": 400 },
    { "wait": 700 },
    { "expect": { "shell.tooltip.text": "AirPods Pro — Not connected" } },
    { "click": "icon" },
    { "waitFor": "s.app.pending === null", "timeout": 5000 },
    { "expect": { "app.tooltip": "AirPods Pro — Connected", "log": "Connect confirmed after" } },
    { "shot": "connected" }
  ]
}
```

| Step | Meaning |
| --- | --- |
| `hover` / `move`, `click`, `rightClick`, `doubleClick` | Real mouse events at a target. `"ms"` makes the move take that long (visible in recordings). |
| `key` | Keyboard key (menus: arrows, Enter, Escape). |
| `wait` | Advance virtual time (ms). |
| `waitFor` | JS expression over the state `s`; advances until true or `timeout` (fails the run). |
| `expect` | Dot paths into the state → value, or `{"match": regex}`, `{"includes": x}`, `{"min","max"}`, `{"approx","tol"}`, `{"not": x}`. `"log"` / `"logNot"`: some / no line of quicktooth.log contains the text. |
| `shot` | Screenshot (`region`, `zoom` per step or per scenario). |
| `profile`, `theme`, `scale`, `tune`, `cli`, `bt`, `eval` | Change the world: `{"bt": ["externalDisconnect", "AirPods Pro"]}`, `{"cli": "--toggle"}`, `{"eval": "qt.restartExplorer()"}`. |

State paths (see `final-state.json` of any run): `app.pending`, `app.anim`, `app.animT`, `app.tooltip`,
`app.icon` (`{kind: static, state}`, plus `lowBattery: true` with the orange dot, or `{kind: anim, phase, t}`), `app.timers`, `app.battery`,
`shell.tooltip`, `shell.menu[i].items/hot/rect`, `shell.iconInOverflow`, `shell.flyoutOpen`,
`bt[i].a2dp/hfp/link`, `t`.

## In the page: `window.qt`

Everything the CLI does goes through `window.qt`, which you can also drive from your own Playwright code:
`qt.state()`, `qt.log()`, `qt.timeline()`, `qt.advance(ms)`, `qt.waitFor(fn, timeoutMs)`,
`qt.setMode('manual'|'realtime', speed)`, `qt.cli('--toggle')`, `qt.locate('icon')`,
`qt.profile('slow')` or `qt.profile({ hfpMs: [5000, 6000] })`, `qt.bt.externalConnect('AirPods Pro')`,
`qt.bt.externalDisconnect(…)`, `qt.bt.setInRange(…, false)`, `qt.bt.setPresent(…, false)`, `qt.bt.setBattery(…, {left: 20})`,
`qt.setTheme('light')`, `qt.setScale(1.5)`, `qt.restartExplorer()`, `qt.setPromoted(false)`,
`qt.restartApp({ firstRun: true })`, `qt.tune({ Travel: 2.4 })`, `qt.frames({ phase, durationMs, size })`.
Use `lib/session.mjs` (`Session.open({...})`) to get a page that is set up correctly: manual clock, physical-pixel scale, and host-driven DPI changes.

## Bluetooth profiles

| Profile | What happens on a connect |
| --- | --- |
| `fast` | ~1.0–1.2 s, the README demo case |
| `typical` (default) | confirmed after ~1.5–3 s, the middle of the real log, no surprises |
| `real-world` | the real log's spread: 25 % slow pages (3.5–9.5 s), 6 % lost requests, 15 % slow disconnects |
| `slow` | 8.6–10.5 s: the 8 s resend fires first |
| `flaky` | first request lost, the resend lands (the real 13 s case) |
| `unreachable` | never lands, so the 20 s timeout and cancel animation run |
| `rejected` | the driver refuses (hr 0x80070490), so the attempt ends at once |
| `long-linger` | the old link outlives the 5 s teardown wait, so the reconnect stalls 15 s+ |
| `hfp-very-slow` | hands-free takes 10–20 s (what Windows Quick Settings often hits) |

Every knob can be set alone: `hfpMs`, `hfpTailChance`/`hfpTailMs`, `a2dpAfterHfpMs`,
`disconnectA2dpMs`, `disconnectHfpMs`, `slowDisconnectChance`, `lingerMs`, `teardownStallMs`, `dropRate`,
`dropFirst`, `neverConnects`, `ksReject`, `notifyMs`, `notifyHidden`, `enumerateMs`, `sendMs`, `bleHeard`,
`bleScanMs`. Ranges are `[min, max]` and are drawn with a seeded RNG, so `--seed` makes runs repeat exactly.

## How faithful is it?

| Area | Status | Checked by |
| --- | --- | --- |
| Taskbar/tray geometry at 100 % | measured with UI Automation; all 12 elements match exactly | `test` (geometry) |
| Icon pixels (static + every animation frame) | the app's own renderer; matches `QuickTooth.exe --render-icons` within 1/255 (mean 0.03–0.05) | `parity` |
| Tray behaviour (state machine, timers, log lines, tooltip, menu contents) | the app's own `TrayController`; only Win32 and Bluetooth are simulated | `test` (scenarios) |
| Icon reaching the screen unresampled at 100–200 %, and after a runtime DPI change | exact, max Δ 0 | `test` (pixels) |
| Popup menu: size, items, placement, submenu, colours | measured from real menus; exact geometry | `menu-check` |
| Animation cadence | measured: `SetTimer(83)` ticks every ~94.8 ms (~10.5 fps) | `reference/probe/timerprobe.cs` |
| Connect/disconnect timings | calibrated on the real log | `reference/metrics.json` |
| Tooltip, hover pill | from the 1.5× demo video | extrapolated |
| Other scales, DWM menu corners/shadow, fades, overflow flyout | reasoned, not measured | extrapolated |

`reference/metrics.json` lists every number with its source. The probes in `reference/probe/`
(`dotnet run sim/reference/probe/menuprobe.cs -- dark <dir>`) re-measure the menu and timer. They open a
throwaway menu or timer of their own and never touch a running QuickTooth.

Not simulated: keyboard focus in the tray (Win+B, arrows), notification balloons, multiple monitors,
Quick Settings and anything else that isn't on QuickTooth's path.

## Changing the app

There is nothing to keep in sync: the simulator runs `src/QuickTooth.Core`, the same C# as the exe.

- **Looks, animation, behaviour, menu contents, tooltip text, timings**: change `src/QuickTooth.Core`. The next `qt-sim` run rebuilds the browser build; run `bun qt-sim.mjs test`.
- **Numbers only**: `--tune` (or `qt.tune({...})`) overrides any `Tunables.cs` value in the page without touching the C#.
- **The Windows side** (`src/QuickTooth/TrayApp.cs`: window, Shell_NotifyIcon, menus, HICONs; `WindowsDevices.cs`: real Bluetooth) isn't run here. Its page-side counterparts are `web/tray.js` (TrayAppModel's host methods) and `web/bluetooth.js`.
