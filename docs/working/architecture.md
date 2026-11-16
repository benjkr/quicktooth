# Architecture and file map

Read "Where code goes" and "Rules" before writing code; use the file map to locate an area.

## Where code goes

- **A behaviour, a look, a piece of text or a number belongs in `src/QuickTooth.Core`.** A host
  only adapts the platform. If both hosts would need the same code, it's core code.
- **Windows-only** (calls Win32, COM, WinRT, the registry or files outside settings and the log):
  `src/QuickTooth`.
- **Browser glue**: `src/QuickTooth.Web` (C# side) and `sim/web/tray.js` (JS side).
- **What Windows itself draws** (taskbar, tooltip box, menu box): the simulator's `sim/web/shell.js`
  and `menu.js`, kept true to the measurements in `sim/reference/`.

## Rules

- Hosts implement `ITrayHost` and `IDeviceBackend` (`TrayHost.cs`). Add a member there only for
  something the platform really provides, and implement it in both hosts in the same change.
- `TrayController` is single-threaded: host calls and await continuations run on the UI thread
  (Windows: `UiContext` via `PostMessage`; browser: `InlineContext`). Endpoint notifications
  arrive on other threads and go through `EndpointChangedDispatcher`.
- **Time comes only from the host** (`NowMs`, `Now`, `Delay`, `SetTimer`). Never `Stopwatch`,
  `Task.Delay` or `DateTime.Now` in core: the simulator's virtual clock depends on it.
- Numbers go in `Tunables` (named, settable, listed in its table), not inline.
- No per-app static state in core: the simulator runs several app instances in one page.
  Per-process hooks (`Log.Sink`, `Settings.SaveHandler`) are set by each host at start.
- Native AOT: no reflection. JSON uses source-generated contexts. COM uses `GeneratedComInterface`,
  and every interface received is a unique instance (`UniqueComInterfaceMarshaller`) released
  with `FinalRelease`. Regexes use `GeneratedRegex` where they're hot.
- Only `BluetoothAudio.SendOneShot` sends to a device, and only to one container ID.
- One source of truth: no copies of logic or values (the simulator's JavaScript copies were
  removed for this reason), no configuration for things that never vary, and no special case
  unless the platform forces it, with a comment saying which platform quirk.

## File map

- `src/QuickTooth.Core` (net10.0, no Windows APIs):
  - `TrayController.cs`: the state machine. `TrayHost.cs`: host interfaces, `IconImage`,
    `MenuItem`, `TrayCommands`.
  - `IconRenderer.cs` (rasterizer, glyphs, animation, PNG writer), `Tunables.cs`, `Settings.cs`.
  - `Devices.cs` (device records, `DeviceState`, `SendLog`), `Battery.cs` (reading, Apple advert
    parser), `Log.cs`.
- `src/QuickTooth` (Windows, Native AOT): `Program.cs`, `TrayApp.cs` (the Win32 host),
  `WindowsDevices.cs`, `BluetoothAudio.cs`, `Battery.cs` (BLE scanner), `NativeIcons.cs`, `Cli.cs`,
  `Autostart.cs`, `Theme.cs`, `TrayPromotion.cs`, `LogFile.cs`, `SelfTest.cs`, `DeviceWorker.cs`,
  `Native/` (COM interfaces, PnP, Win32).
- `src/QuickTooth.Web` (browser-wasm): `Bridge.cs` (JS exports and imports, `WebHost`,
  `WebDevices`), `Program.cs` (`InlineContext`).
- `src/Directory.Build.props` / `.targets`: shared settings, the runtime patch pin.
- `sim/`: `qt-sim.mjs` (CLI), `lib/` (session, scenarios, checks, parity, core build), `web/` (the
  page: `core.js`, `tray.js`, `icon.js`, `shell.js`, `menu.js`, `bluetooth.js`, `clock.js`,
  `main.js`, `panel.js`), `scenarios/`, `reference/` (measured metrics and probes).
- `installer/` (Inno Setup script, build script), `publish.ps1`, `tools/` (glyph generator),
  `assets/`, `docs/`.
