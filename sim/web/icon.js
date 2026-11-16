// Port of src/QuickTooth/IconRenderer.cs: draws the AirPods Pro glyphs (assets/airpods-pro-*.svg)
// at the exact small-icon size and returns straight-alpha pixels, like the HICON the app hands the
// shell. The animation math is a line-for-line port of IconRenderer.RenderAnim; `qt-sim parity`
// diffs this renderer against the real one (QuickTooth.exe --render-icons) frame by frame.
//
// Prototyping a new look: pass `variant` hooks to IconRenderer (see web/variants/README.md) or
// tweak the tunables; nothing here needs a rebuild of the app.

export const PHASES = ['Connecting', 'Landing', 'Disconnecting', 'Cancelling'];

/** Parses a generated glyph SVG into layers (Path2D + fill-opacity), vertex bounds, and the tracer orbit. */
export function parseGlyph(svgText, name = 'glyph') {
  const layers = [];
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const tag of svgText.match(/<path\b[^>]*>/g) ?? []) {
    const d = tag.match(/\sd="([^"]+)"/)?.[1];
    if (!d) continue;
    const op = tag.match(/\sfill-opacity="([^"]+)"/);
    layers.push({ d, path: new Path2D(d), opacity: op ? Number(op[1]) : 1 });
    // The generator writes only M/L/Z with absolute coordinates, so the bounds are the vertex bounds
    // (what WPF's Geometry.Bounds returns for straight segments).
    const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i], y = nums[i + 1];
      if (x < left) left = x; if (x > right) right = x;
      if (y < top) top = y; if (y > bottom) bottom = y;
    }
  }
  if (!layers.length) throw new Error(`no <path> in ${name}`);
  const tr = svgText.match(/\sdata-tracer="([^"]+)"/);
  const tracer = tr ? tr[1].trim().split(/\s+/).map(Number) : null;
  return { name, layers, bounds: { left, top, right, bottom }, tracer: tracer?.length === 4 ? tracer : null };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** .NET Math.Round: midpoints go to the even neighbour. */
const roundEven = (v) => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };

export const easing = { clamp01, easeOut, easeInOut };

export class IconRenderer {
  /**
   * @param {{fill, line}} glyphs parsed glyphs
   * @param {object} P constants/tunables (Zoom, Travel, TracerPeriod, SpotRadius, *Seconds, OnDarkTaskbar, OnLightTaskbar)
   * @param {object} [variant] optional hooks: { pose(phase, t, tracerT, P, base) → {dx, level, tracer, tracerT}, draw(ctx, frame, api) }
   */
  constructor(glyphs, P, variant = null) {
    this.fill = glyphs.fill;
    this.line = glyphs.line;
    this.P = P;
    this.variant = variant;
    this._canvases = new Map();
  }

  get artBounds() {
    const a = this.fill.bounds, b = this.line.bounds;
    return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
  }

  /** Zoom of the fully-apart pose (IconRenderer.ApartZoom). */
  get apartZoom() { return Math.min(this.P.Zoom, 12 / (12 - this.artBounds.left + this.P.Travel)); }

  get orbit() {
    const t = this.line.tracer;
    if (t) return { cx: t[0], cy: t[1], rx: t[2], ry: t[3] };
    const b = this.artBounds, r = (12 - b.left) / 2;
    return { cx: b.left + r, cy: b.top + r, rx: r, ry: r };
  }

  color(light) { return light ? this.P.OnLightTaskbar : this.P.OnDarkTaskbar; }

  _ctx(size) {
    let c = this._canvases.get(size);
    if (!c) {
      const canvas = new OffscreenCanvas(size, size);
      c = canvas.getContext('2d', { willReadFrequently: true });
      this._canvases.set(size, c);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, size, size);
    return c;
  }

  /** IconRenderer.GlyphTransform: the 24-unit box (centre 12,12) onto `size` px at `zoom`. */
  _glyphTransform(ctx, size, zoom) {
    const s = size * zoom / 24;
    ctx.transform(s, 0, 0, s, size / 2 - 12 * s, size / 2 - 12 * s);
  }

  _drawGlyph(ctx, glyph, hex, opacity) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (const layer of glyph.layers) {
      // WPF: Color.FromArgb((byte)Math.Round(255 * clamp(opacity)), …) per layer.
      const a = roundEven(255 * clamp01(opacity * layer.opacity));
      if (a === 0) continue;
      ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
      ctx.fill(layer.path, 'nonzero');
    }
  }

  _clipRect(ctx, x, y, w, h) {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }

  /** Static icon: 'connected' (fill glyph) or 'disconnected' (line glyph). Returns ImageData (straight alpha). */
  renderStatic(state, light, size) {
    const ctx = this._ctx(size);
    this._glyphTransform(ctx, size, this.P.Zoom);
    this._drawGlyph(ctx, state === 'connected' ? this.fill : this.line, this.color(light), 1);
    return ctx.getImageData(0, 0, size, size);
  }

  /** The pose of the pending animation at t (IconRenderer.RenderAnim's switch). */
  pose(phase, t, tracerT) {
    const P = this.P;
    let dx, level, tracer;
    switch (phase) {
      case 'Connecting':
        dx = P.Travel * easeOut(clamp01(t / P.SpringSeconds));
        level = 0;
        tracer = clamp01(t / 0.15);
        break;
      case 'Landing': {
        const u = clamp01(t / P.LandSeconds);
        dx = P.Travel * (1 - easeOut(clamp01(u / 0.5)));
        level = easeInOut(clamp01((u - 0.2) / 0.8));
        tracer = 1 - clamp01(u / 0.3);
        break;
      }
      case 'Disconnecting': {
        const u = clamp01(t / P.DisconnectSeconds), a = clamp01(u / 0.6);
        dx = P.Travel * easeOut(a) * (1 - easeInOut(clamp01((u - 0.6) / 0.4)));
        level = 1 - easeInOut(a);
        tracer = t > P.DisconnectSeconds ? clamp01((t - P.DisconnectSeconds) / 0.15) : 0;
        tracerT = Math.max(0, t - P.DisconnectSeconds);
        break;
      }
      default: { // Cancelling
        const u = clamp01(t / P.CancelSeconds);
        dx = P.Travel * (1 - easeOut(u));
        level = 0;
        tracer = 1 - u;
        break;
      }
    }
    const base = { dx, level, tracer, tracerT };
    return this.variant?.pose ? { ...base, ...this.variant.pose(phase, t, tracerT, P, base) } : base;
  }

  /** One frame of the pending animation (IconRenderer.RenderAnim). t: seconds into the phase; tracerT: tracer seconds. */
  renderAnim(phase, t, tracerT, light, size) {
    const P = this.P;
    const { dx, level, tracer, tracerT: spotT } = this.pose(phase, t, tracerT);
    const ctx = this._ctx(size);
    const color = this.color(light);
    if (this.variant?.draw) {
      this.variant.draw(ctx, { phase, t, tracerT: spotT, dx, level, tracer, light, size, color }, this._api(ctx, size, color));
      return ctx.getImageData(0, 0, size, size);
    }
    const travel = P.Travel || 1e-9;
    const poseZoom = P.Zoom + (this.apartZoom - P.Zoom) * (dx / travel);
    const art = this.artBounds;
    const yLevel = art.bottom - level * (art.bottom - art.top);
    const angle = 2 * Math.PI * spotT / P.TracerPeriod;
    const orbit = this.orbit;

    ctx.save();
    this._glyphTransform(ctx, size, poseZoom);
    for (const [left, offset] of [[true, -dx], [false, dx]]) {
      ctx.save();
      ctx.translate(offset, 0);
      this._clipRect(ctx, left ? 0 : 12, 0, 12, 24); // one earbud per half

      // Above the fill line: the dim outline, plus the tracer spot.
      ctx.save();
      this._clipRect(ctx, 0, 0, 24, yLevel);
      this._drawGlyph(ctx, this.line, color, 1);
      if (tracer > 0.001) {
        const cx = left ? orbit.cx : 24 - orbit.cx, dir = left ? 1 : -1;
        const sx = cx + dir * orbit.rx * Math.sin(angle), sy = orbit.cy - orbit.ry * Math.cos(angle);
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(sx, sy, P.SpotRadius, P.SpotRadius, 0, 0, 2 * Math.PI);
        ctx.clip();
        this._drawGlyph(ctx, this.line, color, tracer);
        ctx.restore();
      }
      ctx.restore();

      // Below the fill line: solid.
      if (level > 0.001) {
        ctx.save();
        this._clipRect(ctx, 0, yLevel, 24, 24 - yLevel);
        this._drawGlyph(ctx, this.fill, color, 1);
        ctx.restore();
      }
      ctx.restore();
    }
    ctx.restore();
    return ctx.getImageData(0, 0, size, size);
  }

  /** Helpers handed to variant.draw hooks. */
  _api(ctx, size, color) {
    return {
      fill: this.fill, line: this.line, art: this.artBounds, orbit: this.orbit, apartZoom: this.apartZoom, P: this.P,
      glyphTransform: (zoom) => this._glyphTransform(ctx, size, zoom),
      drawGlyph: (glyph, opacity = 1, hex = color) => this._drawGlyph(ctx, glyph, hex, opacity),
      clipRect: (x, y, w, h) => this._clipRect(ctx, x, y, w, h),
      easing,
    };
  }

  /** Is the phase finished at t (TrayApp.AdvanceAnimation)? */
  phaseDone(phase, t, stillPendingDisconnect) {
    const P = this.P;
    switch (phase) {
      case 'Landing': return t >= P.LandSeconds;
      case 'Cancelling': return t >= P.CancelSeconds;
      case 'Disconnecting': return t >= P.DisconnectSeconds && !stillPendingDisconnect;
      case 'Connecting': return false;
      default: return true;
    }
  }
}

/** Small-icon size (SM_CXSMICON) for a display scale: 16 px at 100 %, 20/24/28/32 at 125–200 %. */
export function smallIconSize(scale) { return Math.round(16 * scale); }

/** Composites straight-alpha icon pixels over an opaque background, like DrawIconEx onto the taskbar. */
export function compositeOver(img, bgHex) {
  const [br, bg, bb] = [1, 3, 5].map((i) => parseInt(bgHex.slice(i, i + 2), 16));
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = img.data[i + 3];
    out[i] = Math.round((img.data[i] * a + br * (255 - a)) / 255);
    out[i + 1] = Math.round((img.data[i + 1] * a + bg * (255 - a)) / 255);
    out[i + 2] = Math.round((img.data[i + 2] * a + bb * (255 - a)) / 255);
    out[i + 3] = 255;
  }
  return new ImageData(out, img.width, img.height);
}
