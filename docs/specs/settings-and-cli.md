# Settings, log and command line

Part of the specs (index in `AGENTS.md`). What the app does now. Keep it current in the same
change, and lean.

## Settings: `%APPDATA%\QuickTooth\settings.json`

- `targetContainerId` (primary), `targetMac` (fallback), `targetName` (display only) and
  `trayPromotedOnce`. Read and written through a source-generated JSON context; saved through a
  temp file and a move.
- A stored target is never swapped for another device: if it's missing, the tray says
  "Not available". With no target saved yet, the first paired device whose name contains
  "AirPods" (a connected one first) is chosen and saved.

## Log: `%APPDATA%\QuickTooth\quicktooth.log`

- `yyyy-MM-dd HH:mm:ss.fff [pid] message`, moved to `.old` at 512 KB. Shared code logs through
  `Log` (its sink is set by each host); the CLI can echo lines to the console.
- The lines are compared across builds and with the simulator's log, so treat their wording as
  behaviour (`AGENTS.md`).

## Command line: `QuickTooth.exe [option]` (no option starts the tray)

- For people: `--toggle`, `--connect`, `--disconnect` (forwarded to the running tray, so they act
  exactly like a click; `--no-wait` returns at once), `--list [--all]`, `--battery`,
  `--autostart on|off|status`, `--exit`, `--version`, `--help`.
- Read-only checks for agents and tests: `--probe <endpoint id>`, `--render-icons <dir> [--zoom z]`,
  `--icon-rect`, `--show-menu` / `--close-menu`, `--settings-roundtrip <in> <out>`,
  `--stress-enumerate N`, `--watch-endpoints S`, `--selftest-icons [cycles]`
  ([testing](testing.md) says what each proves).
- Experiments: `--direct` (send without the tray) and `--a2dp-only` (A2DP control only; slow, see
  [decisions](../working/decisions.md)).
- Start with Windows is the value `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\QuickTooth`
  = `"<exe path>"`.
