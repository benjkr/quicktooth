# Testing: what to run and what it proves

Part of the specs (index in `AGENTS.md`). Keep it current in the same change, and lean.

## Shared code (looks and behaviour)

- `cd sim; bun qt-sim.mjs test` (about a minute) runs:
  - `parity`: the browser build's icons against `QuickTooth.exe --render-icons`, within 1/255.
  - `menu-check`: the menu against real Win32 menu captures.
  - Taskbar geometry against UI Automation measurements.
  - Physical-pixel integrity at 100–200% scaling.
  - Every scenario in `sim/scenarios` that asserts something.
- A new behaviour or bug gets a scenario with expectations (tooltip, icon state, log lines,
  timeline).
- A refactor that shouldn't change behaviour: run every scenario with seeds 1–3 before and after
  and diff each `quicktooth.log`, `timeline.json` and `final-state.json`. They must be identical.

## Windows side and devices (the simulator doesn't run these)

All read-only, from a build in a scratch folder (not installed):

- `--list --all` and `--probe <endpoint id>` diffed against the previous build's output: device
  discovery and grouping unchanged.
- `--render-icons <dir>`, compared byte for byte, for any change that shouldn't alter the look.
- `--stress-enumerate 300`: the handle count stays flat. COM objects are released.
- `--selftest-icons`: the real controller through hundreds of animation frames as HICONs, with GDI
  and USER object counts staying flat.
- `--watch-endpoints 15`: the notification callback works through its COM vtable, and the audio
  service delivers callbacks.
- `--battery`: adverts heard with 0 handler errors (the reading needs the AirPods out of the case).
- `dumpbin /dependents QuickTooth.exe`: only Windows DLLs and the universal CRT.

## The installer

Silent install over a running copy; an update with autostart off (it stays off); uninstall (the
folder, Run value and Start menu entry go; settings stay); reinstall. Then the user's own state
is put back ([live testing](../working/live-testing.md)).

## Live, with the real AirPods

Only with the user's go, following [live testing](../working/live-testing.md). Check the log: a
send went only to the target's two IDs, and how long each connect and disconnect took.
