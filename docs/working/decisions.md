# Decisions: what was replaced, and why

Check the relevant entries before changing a behaviour or look; don't reintroduce these.

## Connecting

- **Sending the reconnect to the A2DP control only**: 9 s, 15 s, or not within 40 s. Sending it to
  A2DP and HFP together: 1–3 s.
- **Reconnecting during the link teardown** (~3 s after a disconnect) stalled for 15 s or more. The
  connect now waits for the link flag to drop.
- **Judging success by the send's result**: the state is the truth; only a refusal from every
  control ends the attempt early.

## Look and animation

- **MingCute icons** were replaced by the two-tone AirPods Pro glyphs.
- **A 0.45 px outline** on the not-connected glyph was too faint to see in the taskbar: now 0.7 px.
  Making the buds bigger instead was tried and rejected by the user. Stretching them 1.3× taller
  looked thin and distorted; turning the heads 25° tip-down with longer stems (about a quarter
  bigger) wasn't chosen. The pair already fills the 16 px width.
- **Low battery**: chosen from five designs, an orange dot in the corner (shown in red first; the
  user picked orange). Not chosen: a small battery badge cut into the right stem, the whole icon in
  red, a level bar under the buds, and the stems as red/faint gauges. Its animation, from five:
  a ripple, repeated every 3 s at the user's request (the first proposal replayed once a minute).
  Not chosen: the dot popping in, filling up like the buds, a glint across it, a drop running
  down the stem into it.
- **Pulsing** while connecting: the user asked why it pulsed. Replaced, from five non-pulsing
  designs, by the glow ("tracer") with the earbuds snapping together and filling up when they land.
- **The glow as a spot circling the head**, then as a disc as wide as the stem (both sides of the
  stem lit at once, so it seemed to bounce): replaced by a thin band running along the outline.

## Building and shipping

- **WPF to draw the icons**: pulled in the UI framework and ruled out Native AOT. Replaced by the
  shared rasterizer, which is also closer to the exact shape at the edges.
- **A self-contained bundle** (165 MB installed, 48 MB download), **compressed single file**
  (69 MB of RAM instead of 30 MB) and **trimming** (switches off the COM and JSON the app uses, so
  it finds no devices): all replaced by Native AOT.
- **Needing the .NET Desktop Runtime installed**: replaced; the exe needs nothing.
- **The SDK's default .NET 10.0.5 runtime** (CVE-2026-111497): pinned to at least 10.0.15.

## Simulator

- **Node and npm to run the simulator**: replaced by Bun (`bun install`, `bun qt-sim.mjs`). Bun
  1.3.8 hung in Playwright's Chromium launch on Windows, over the pipe and over `connectOverCDP`;
  1.4.4 passes the whole suite, so the launcher refuses anything older. pnpm was the fallback and
  isn't needed.

- **JavaScript copies of the renderer and tray logic**, kept in step by parity checks: replaced by
  the shared C# core compiled to WebAssembly. JavaScript `--variant` sketches went with them;
  `--tune` stays.
- **`Task.Delay` / `Stopwatch` in shared code** broke the virtual clock's determinism. All time
  comes from the host.
