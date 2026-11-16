# Real devices, the installed app and the desktop

Read before anything that talks to real Bluetooth devices, installs or restarts QuickTooth, or
looks at the user's screen.

## Bluetooth devices

- The user's PC has other paired Bluetooth audio devices, a hearing aid among them. **Only the
  stored target may ever receive a connect or disconnect.** Check the log after any live run: every
  `KsProperty` line names one of the target's two IDs.
- Always fine, because they send nothing: `--list`, `--probe`, `--battery`, `--watch-endpoints`,
  `--stress-enumerate` (it activates KS controls but sends no property), `--render-icons` and
  `--selftest-icons`.
- **A live connect or disconnect needs the user's go in the current request.** First:
  1. Warn them (`send_to_user`) that the AirPods will connect and disconnect and must be out of the
     case.
  2. Agree how many cycles.
  3. Leave the AirPods connected or disconnected as they were.
- Live timing varies (one connect may take 4 s); compare several cycles, or the log's history,
  before calling something slower.

## The installed app

- It's `main`'s build (`AGENTS.md`). Don't replace it to try a branch. Run checks from a build in a
  scratch folder instead; starting the tray from another path also adds a stray
  `NotifyIconSettings` entry, so ask the user first.
- Before an install test, record three things:
  - the Run value `HKCU\…\Run\QuickTooth`;
  - the hash of `%APPDATA%\QuickTooth\settings.json`;
  - QuickTooth's `NotifyIconSettings` `IsPromoted` value.

  Afterwards, check all three are back, the tray is running, and say so.
- A tray CLI command (`--exit`, `--connect`) acts on the running tray exactly like a click.

## The desktop

- Never change the theme or restart Explorer. Screenshots only of the tray corner, never the whole
  desktop.
- The taskbar may be hidden or the PC locked. Look at the tray in the simulator instead of
  guessing from the screen.
