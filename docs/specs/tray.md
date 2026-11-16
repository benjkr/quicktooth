# Tray icon

Part of the specs (index in `AGENTS.md`). What the app does now; defaults are in
`src/QuickTooth.Core/Tunables.cs`. Keep it current in the same change as the code, and lean:
rewrite a bullet when something changes; history goes in commits and PRs.

The behaviour is `TrayController` (shared); `TrayApp` is its Windows host.

## The icon and its text

- Connected: the solid glyph with dimmed ear tips. Not connected, not available or no device: the
  hollow outline with solid ear tips. White on a dark taskbar, `#1A1A1A` on a light one (Windows
  mode, `SystemUsesLightTheme`). Low battery: the connected glyph with an orange dot in the
  bottom-right corner while the tooltip shows a reading of 20% or less for the emptier bud, not
  while charging ([icon](icon-and-animation.md)). Rebuilt when the theme flips (`WM_SETTINGCHANGE`
  "ImmersiveColorSet") and when the small-icon size changes (DPI or display change, checked again
  on every idle poll).
- Tooltip and menu header: `<device> — <status>`, plus ` · <battery>` while connected and the
  reading is under 15 min old. Status: Checking…, Connected, Not connected, Not available (the
  saved device is missing), No device selected, Connecting…, Disconnecting…. Capped at 127
  characters (`szTip`).

## Clicks and commands

- Left click or keyboard select (`NIN_SELECT`, `NIN_KEYSELECT`) toggles the target. With no
  target, the menu opens at the cursor. A click while an action is pending is ignored (logged).
- Another `QuickTooth.exe` sends commands through the registered message `QuickTooth.Command.v1`
  to the window class `QuickTooth.TrayWindow`: toggle, connect, disconnect, exit, show-menu
  (anchored at the icon's top centre) and close-menu.

## Connect and disconnect

- **Connect**: if the Bluetooth link is still up from a recent disconnect (it lingers ~3 s), wait
  for it to close, checking every 200 ms for up to 5 s (logged when over 300 ms). Then send the
  one-shot to every KS control of the target, A2DP first, then HFP. Start a 20 s timeout, poll
  the state every 0.5 s, and resend once if still not connected after 8 s.
- **Disconnect**: send at once; same timeout and polling; no resend.
- Success is judged from the endpoints' state, never from the send's result. The attempt ends
  early only if no control accepted the request. On timeout the icon goes back to the real state
  (logged "timed out … showing the real state").
- While idle: a refresh every 20 s, and 200 ms after any endpoint notification.
- Battery while connected: first scan 2.5 s after connecting, then a check every 60 s that rescans
  when the reading is over 5 min old; opening the menu rescans when it's over 60 s old. How it's
  read: [bluetooth](bluetooth.md).

## Menu

- Order: the status line (grayed), separator, Connect or Disconnect, Device ▸, separator,
  Start with Windows, Exit.
- While an action is pending, the second item is the grayed status (Connecting…) and Device is
  grayed. With no target, the second item is a grayed Connect.
- Device ▸ lists the paired Bluetooth audio devices (the target checked, `  (connected)` after
  connected ones). A saved target that's missing appears grayed and checked as
  `<name> (not available)`; none at all: "No Bluetooth audio devices". Picking one saves it as
  the target.
- Start with Windows is checked when the `HKCU\…\Run\QuickTooth` value exists; clicking toggles
  it. The menu's dark/light look follows the taskbar theme.

## Taskbar integration

- A hidden top-level window (a message-only window gets neither "TaskbarCreated" nor
  `WM_SETTINGCHANGE`), `Shell_NotifyIcon` version 4.
- Adding the icon retries every 2 s, up to 60 times (a stale icon, or Explorer not ready at
  sign-in). On "TaskbarCreated" (Explorer restarted) it's added again with fresh icons.
- First run only: marks its own `NotifyIconSettings` entry `IsPromoted=1`, so the icon sits on the
  taskbar instead of in the overflow. Retries every 3 s, up to 10 times, until Explorer has written
  the entry; then never again (`trayPromotedOnce`), so the user's own choice stands.
- One tray per user session (mutex `Local\QuickTooth.Tray.6F0C2B1E`); a second start exits.
