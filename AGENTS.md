# AGENTS.md

QuickTooth: a Windows 11 notification-area icon that connects or disconnects the user's AirPods in
one click, in about 1–3 s instead of ~16 s through Quick Settings. C# / .NET 10, shipped as one
Native AOT exe. The same app code also runs in a browser simulator of the taskbar.

**Read this whole file before changing anything.** Then read the spec for the area you touch and
the working rules that apply (tables below); don't load unrelated documents. Keep this file, the
working rules and the specs current in the same change as the code.

## Rules every change follows

- **One codebase, two hosts.** Behaviour and looks live in `src/QuickTooth.Core`, which has no
  Windows APIs: the icon and its animation, the tray state machine, tooltip and menu text,
  settings, and every timing number (`Tunables.cs`). The Windows app (`src/QuickTooth`) and the
  simulator's WebAssembly build (`src/QuickTooth.Web`) only adapt the platform. Never copy core
  logic into JavaScript or a host ([architecture](docs/working/architecture.md)).
- **Show it in the simulator before it ships.** A change to what the tray looks like or does is
  previewed from `sim/` (stills, recordings, before/after), and `bun qt-sim.mjs test` passes on
  the final code.
- **Only the target device is ever sent anything.** Connect/disconnect goes to the stored target
  only (container ID, then MAC), never "the first headset". Other paired devices must never receive
  a one-shot. A live test needs the user's go in that request and a warning first
  ([live testing](docs/working/live-testing.md)).
- **Only `main` is installed on the user's PC** (tagged releases once they exist). Never install a
  branch, an open PR or anything unmerged with `publish.ps1` or the installer. Unmerged work is
  previewed in the simulator or checked read-only from a scratch build.
- **Leave the user's system alone**: no theme changes, no Explorer restarts, screenshots of the
  tray corner only, never the whole desktop. After any install test, the user's autostart,
  settings and pinned tray icon are back as they were.
- **Native AOT stays clean**: zero AOT/trim warnings, no reflection (JSON and COM are
  source-generated), and the runtime patch pin in `src/Directory.Build.targets` never goes backwards.
- **Log lines are behaviour.** `quicktooth.log` lines are compared across builds, the simulator and
  live runs; change their wording only on purpose, with whatever reads them.
- Work on a named branch, never on `main`. Commit finished work; open PRs when asked; merge only
  when the user asks in that request ([pull requests](docs/working/pull-requests.md)).
- Project knowledge lives in these documents, not in agent memory: auto-memory is off for this
  project (`.claude/settings.json`). Don't read or write it.

## Token and execution policy

- Routine work (docs, scripts, tests, mechanical edits) needs no top model or high effort; keep
  those for the rasterizer, COM/interop, timing races and architecture. Honour the user's choice.
- One implementation agent by default. Delegate only independent work with a narrow brief, and
  never give two agents the same files.
- Search first (`rg`) and read the section you need; batch independent calls; keep bulky output
  out of context (logs to files, `| tail`). Don't re-plan settled decisions.
- In the foreground: native AOT publish (~1 min), `bun qt-sim.mjs test` (~1 min), browser core
  build (5–10 s). In the background, with `t3_background_wait`: real-time recordings and anything
  longer. Never sleep-poll.
- Edit with small targeted edits; a script only for one change across many files.
- No narration between tool calls unless the plan changed or the user is needed.

## Verification and delivery

- Core change: `bun qt-sim.mjs test` on the final code. Windows host or device code (the
  simulator doesn't run it): the native read-only checks in the [testing spec](docs/specs/testing.md).
- A refactor that shouldn't change behaviour: record every scenario's log, timeline and final
  state before, and diff them after (identical, line for line).
- Visible changes come with simulator media; numbers that compare are shown as a chart, never a
  table. Before the final reply of a substantial task read [replies](docs/working/replies.md).

## Working rules: load when applicable

| Work | Document |
|---|---|
| Writing code; where code goes; core vs hosts; threading and time | [Architecture and file map](docs/working/architecture.md) |
| Building, tools, local setup, Windows shell quirks, delegating | [Development](docs/working/development.md) |
| Anything touching real Bluetooth devices, the installed app or the desktop | [Live testing](docs/working/live-testing.md) |
| Changing a behaviour or look that was decided before | [Decisions](docs/working/decisions.md) |
| Final reply of a task; showing numbers | [Replies](docs/working/replies.md) |
| Commits, branches, PRs, merges, releases, GitHub comments | [Pull requests and releases](docs/working/pull-requests.md) |

## Specs: read the one for what you touch

| Area | Spec |
|---|---|
| Clicks, connect/disconnect state machine, tooltip, menu, autostart, Explorer/theme/DPI | [tray](docs/specs/tray.md) |
| Artwork, renderer, static icons, animation phases, the glow | [icon and animation](docs/specs/icon-and-animation.md) |
| Finding the headset, one-shot connect/disconnect, link state, notifications, battery | [bluetooth](docs/specs/bluetooth.md) |
| `settings.json`, the log, command-line options, single instance | [settings and CLI](docs/specs/settings-and-cli.md) |
| The browser simulator: what's real, the bridge, mock Bluetooth, commands | [simulator](docs/specs/simulator.md) |
| Native AOT build, runtime pin, installer, `publish.ps1`, what gets installed | [build and install](docs/specs/build-and-install.md) |
| What to run for which change and what each check proves | [testing](docs/specs/testing.md) |

## Keeping documentation lean

This file holds the universal rules and routing; `docs/working/` holds rules that apply to some
kinds of work; each spec says what its area does **now**. When something changes, rewrite the
bullet. History, measurements and discarded designs belong in commits and PRs; a rejected choice
goes in [decisions](docs/working/decisions.md) only so it isn't reintroduced. A new area gets a
spec and a row above. Defaults live in code (`Tunables.cs`), not in the docs' prose.

## Owner's notes

This section is written by the owner. Agents don't change it.
