# Development workflow

Read before building, running tools, setting up a machine or delegating.

## Setup

- .NET 10 SDK; Visual Studio (or its Build Tools) with "Desktop development with C++" for the
  Native AOT linker.
- `cd sim; bun install` once (Bun 1.4.4+; Playwright 1.60 with its Chromium). ffmpeg on `PATH` for
  recordings, GIFs and `--zoom`.
- Inno Setup 6.7+ for the installer (`winget install JRSoftware.InnoSetup`). Python with `shapely`
  only for regenerating the glyphs.

## Commands and how long they take

- `dotnet build src/QuickTooth -c Release`: a quick JIT build to run CLI checks; nothing installed.
- `dotnet publish src/QuickTooth/QuickTooth.csproj -c Release -r win-x64 -o <scratch>`: the native
  exe, about a minute. Must show zero warnings.
- `cd sim; bun qt-sim.mjs test`: about a minute; rebuilds the browser core first if needed
  (5–10 s).
- Real-time recordings (`run` of a recorded scenario, `examples/compare-profiles.mjs`) take as long
  as what they show: run them in the background and wait with `t3_background_wait`.
- `installer/build.ps1` and `publish.ps1` only per [build and install](../specs/build-and-install.md),
  and on the user's PC only for `main`.

## This Windows machine

- Git Bash and PowerShell 7 are both available. Use PowerShell for the registry, processes and
  installers.
  - PowerShell 7's `Start-Process -Wait` also waits for child processes, and the installer starts
    the tray. Use `-PassThru` and `.WaitForExit()`.
  - Running a GUI exe with `&` doesn't wait either; use `Start-Process … -Wait`.
- Python's console is cp1252 unless `PYTHONUTF8=1` (set for agents in `.claude/settings.json`).
  `python -I` ignores environment variables, so call `sys.stdout.reconfigure(encoding='utf-8')`
  there.
- Write multi-line scripts to a file and run them. Quoted heredocs with mixed quotes break in Git
  Bash. Edit source with targeted edits, not scripts.

## Delegating

Allowed, for independent work with a narrow brief and the right model and effort (a fast model for
searches and mechanical edits, a strong one for interop and rendering). Never two agents on the
same files, and keep design work that depends on the conversation in the agent holding it.

## Knowledge

Project knowledge goes in `AGENTS.md`, `docs/working/` and the specs. Auto-memory is off for this
project (`.claude/settings.json`): don't read or write it.
