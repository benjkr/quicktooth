// Example variant: instead of a spot circling each earbud while connecting, the whole outline
// "breathes" (pulses in brightness). Try it:
//
//   node qt-sim.mjs frames --compare --variant web/variants/example-breathe.js
//   node qt-sim.mjs run connect-fast --variant web/variants/example-breathe.js
//
// A variant module may export any of:
//   constants  — overrides for the C# constants (same names as IconRenderer.cs / TrayApp.cs)
//   pose(phase, t, tracerT, P, base) → partial { dx, level, tracer, tracerT } to change the pose math
//   draw(ctx, frame, api) — replace drawing entirely; `frame` has the pose, `api` has the glyphs and helpers

export const constants = {
  TracerPeriod: 1.4, // one breath every 1.4 s
};

/** Keep the stock motion (spring apart, land, drain) but drive the brightness pulse from tracerT. */
export function pose(phase, t, tracerT, P, base) {
  return base; // unchanged; the look is changed in draw() below
}

export function draw(ctx, f, api) {
  const { P, art, apartZoom, fill, line, easing } = api;
  const poseZoom = P.Zoom + (apartZoom - P.Zoom) * (f.dx / (P.Travel || 1e-9));
  const yLevel = art.bottom - f.level * (art.bottom - art.top);
  // 0.45…1.0 brightness, sinusoidal; only while the tracer would be visible.
  const breath = 0.45 + 0.55 * (0.5 - 0.5 * Math.cos((2 * Math.PI * f.tracerT) / P.TracerPeriod));
  const outline = 1 - f.tracer * (1 - breath);
  ctx.save();
  api.glyphTransform(poseZoom);
  for (const [left, offset] of [[true, -f.dx], [false, f.dx]]) {
    ctx.save();
    ctx.translate(offset, 0);
    api.clipRect(left ? 0 : 12, 0, 12, 24);
    ctx.save();
    api.clipRect(0, 0, 24, yLevel);
    api.drawGlyph(line, outline);
    ctx.restore();
    if (f.level > 0.001) {
      ctx.save();
      api.clipRect(0, yLevel, 24, 24 - yLevel);
      api.drawGlyph(fill, 1);
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}
