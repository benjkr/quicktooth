// The tray icon renderer in the simulator is the app's own: IconRenderer from src/QuickTooth.Core,
// compiled to WebAssembly (core.js). Same pixels as QuickTooth.exe — `qt-sim parity` checks it.
// This file only wraps it for canvas use and keeps a few page helpers.

export const PHASES = ['Connecting', 'Landing', 'Disconnecting', 'Cancelling'];

export class IconRenderer {
  /**
   * @param {object} core the loaded C# Bridge exports (core.js loadCore())
   * @param {object} P    the C# tunables as last read (kit.P; kit.tune keeps it current)
   */
  constructor(core, P) { this.core = core; this.P = P; }

  /** Static icon: 'connected' (fill glyph) or 'disconnected' (line glyph). Returns ImageData (straight alpha). */
  renderStatic(state, light, size) { return toImage(this.core.RenderStatic(state === 'connected', !!light, size), size); }

  /** One frame of the pending animation. t: seconds into the phase; tracerT: tracer seconds. */
  renderAnim(phase, t, tracerT, light, size) { return toImage(this.core.RenderAnim(phase, t, tracerT, !!light, size), size); }

  /** Is the phase finished at t (TrayController.AdvanceAnimation)? */
  phaseDone(phase, t, stillPendingDisconnect) { return this.core.PhaseDone(phase, t, !!stillPendingDisconnect); }
}

function toImage(rgba, size) {
  return new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength).slice(), size, size);
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
