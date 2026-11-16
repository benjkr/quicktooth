// A simulator session: one Chromium page running sim/web/index.html in manual-clock mode, plus
// helpers to drive it the way a person would (real mouse events), advance virtual time, take
// physical-pixel screenshots of regions, and record frame-accurate video.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, ORIGIN, SIM_DIR } from './browser.mjs';
import { zoomPng, framesToMp4, framesToGif } from './ffmpeg.mjs';

export const DEFAULTS = {
  scale: 1, screen: '1920x1080', theme: 'dark', style: 'solid', profile: 'typical', seed: 1,
  connected: false, firstRun: false, overflow: false, cursor: true, dwm: true, timerQuantum: 15.625,
  tune: null, variant: null, settleMs: 1500, panel: false, mode: 'manual',
};

export class Session {
  static async open(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const [W, H] = o.screen.split('x').map(Number);
    const extraFiles = new Map();
    let variantUrl = null;
    if (o.variant) {
      const abs = path.resolve(o.variant);
      const rel = path.relative(path.join(SIM_DIR, '..'), abs).replace(/\\/g, '/');
      if (!rel.startsWith('..') && rel.startsWith('sim/web/')) variantUrl = '/' + rel;
      else { variantUrl = '/__variant/' + path.basename(abs); extraFiles.set(variantUrl.slice(1), abs); }
    }
    const panelW = o.panel ? 380 : 0;
    const viewport = { width: Math.ceil(W / o.scale) + panelW, height: Math.ceil(H / o.scale) };
    // The context is always created at scale 1; the display scale is applied through one CDP
    // override (below) so it can also change at runtime, and screenshots are taken through CDP at
    // that scale. (Measured: this keeps the icon pixel-exact for every 100–200 % change, including
    // repeated ones; Playwright's own screenshots keep using the context's original scale.)
    const env = await launch({ headless: o.headless ?? true, scale: 1, viewport, extraFiles });
    const s = new Session(env, o, { W, H, variantUrl });
    await s._load();
    return s;
  }

  constructor(env, o, extra) {
    Object.assign(this, env);
    this.o = o;
    this.W = extra.W; this.H = extra.H;
    this.variantUrl = extra.variantUrl;
    this.scale = o.scale;
    this.mouse = { x: -1, y: -1 };
  }

  async _load() {
    const o = this.o;
    const q = new URLSearchParams({
      scale: String(o.scale), screen: o.screen, theme: o.theme, style: o.style, profile: o.profile, seed: String(o.seed),
      mode: o.mode, connected: o.connected ? '1' : '0', firstRun: o.firstRun ? '1' : '0', overflow: o.overflow ? '1' : '0',
      panel: o.panel ? '1' : '0', cursor: o.cursor ? '1' : '0', dwm: o.dwm ? '1' : '0', timerQuantum: String(o.timerQuantum),
    });
    if (o.tune) q.set('tune', typeof o.tune === 'string' ? o.tune : JSON.stringify(o.tune));
    if (this.variantUrl) q.set('variant', this.variantUrl);
    const cdp = this.cdp = await this.context.newCDPSession(this.page);
    const applyScale = async (scale) => {
      const panelW = this.o.panel ? 380 : 0;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.ceil(this.W / scale) + panelW, height: Math.ceil(this.H / scale), deviceScaleFactor: scale, mobile: false });
      this.scale = scale;
    };
    await applyScale(o.scale);
    // Lets the page change its own devicePixelRatio (display scale) like a real DPI change.
    await this.page.exposeFunction('qtHostSetScale', applyScale);
    await this.page.goto(`${ORIGIN}/sim/web/index.html?${q}`);
    await this.page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 30000 });
    if (await this.page.evaluate(() => document.body.dataset.ready) === 'error') throw new Error(await this.page.evaluate(() => document.getElementById('screen').textContent));
    if (o.mode === 'manual' && o.settleMs) await this.advance(o.settleMs);
  }

  eval(fn, arg) { return this.page.evaluate(fn, arg); }
  state() { return this.eval(() => window.qt.state()); }
  log() { return this.eval(() => window.qt.log()); }
  timeline() { return this.eval(() => window.qt.timeline()); }

  async advance(ms) {
    if (this.recorder) return this.recorder.advance(ms);
    await this.eval((ms) => window.qt.advance(ms), ms);
  }

  /** Physical-pixel rect of a named thing: icon, chevron, clock, menu:<label>, or "x,y" / "x,y,w,h". */
  async locate(what) {
    if (typeof what === 'object' && what) return what;
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(what);
    if (m) return { x: Number(m[1]), y: Number(m[2]) };
    const r = await this.eval((w) => window.qt.locate(w), what);
    if (!r) throw new Error(`can't find "${what}" on screen`);
    return r;
  }

  /** Moves the mouse (physical px). With ms > 0 the move takes that much virtual time (and is recorded). */
  async moveTo(what, ms = 0) {
    const t = await this.locate(what);
    const to = { x: t.x, y: t.y };
    const from = this.mouse.x < 0 ? { x: to.x - 120 * this.scale, y: to.y - 160 * this.scale } : { ...this.mouse };
    const steps = ms > 0 ? Math.max(2, Math.round(ms / 16)) : 1;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const p = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      await this.page.mouse.move(p.x / this.scale, p.y / this.scale);
      if (ms > 0) await this.advance(ms / steps);
    }
    this.mouse = to;
    await this.eval(() => window.qt.clock.settle());
    return to;
  }

  async click(what, { button = 'left', holdMs = 60, moveMs = 0 } = {}) {
    if (what != null) await this.moveTo(what, moveMs);
    await this.page.mouse.down({ button });
    await this.eval(() => window.qt.clock.settle());
    if (holdMs) await this.advance(holdMs);
    await this.page.mouse.up({ button });
    await this.eval(() => window.qt.clock.settle());
  }

  /** Physical-px clip for a region name. */
  async region(name = 'tray') {
    const s = this.scale, W = this.W, H = this.H;
    if (typeof name === 'object') return name;
    if (name === 'screen') return { x: 0, y: 0, width: W, height: H };
    if (name === 'taskbar') { const h = Math.round(48 * s); return { x: 0, y: H - h, width: W, height: h }; }
    if (name === 'tray') { const w = Math.min(W, Math.round(560 * s)), h = Math.min(H, Math.round(340 * s)); return { x: W - w, y: H - h, width: w, height: h }; }
    if (name === 'icon') {
      const r = await this.locate('icon');
      const m = Math.round(8 * s);
      return { x: r.left - m, y: r.top - m, width: r.right - r.left + 2 * m, height: r.bottom - r.top + m };
    }
    const m = /^(\d+),(\d+),(\d+),(\d+)$/.exec(name);
    if (m) return { x: +m[1], y: +m[2], width: +m[3], height: +m[4] };
    throw new Error(`unknown region "${name}" (screen | taskbar | tray | icon | x,y,w,h)`);
  }

  /** PNG of a physical-pixel rect, at the current display scale (1 image px = 1 screen px). */
  async capture(r) {
    const s = this.scale;
    // CDP's output size is CSS size × clip.scale × (the compositor's own scale), and whether the
    // compositor follows a DPR override depends on when it was applied. Measure it once per scale.
    if (this._compositorScaleFor !== s) {
      const probe = await this.cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 40, height: 40, scale: 1 } });
      this._compositorScale = Buffer.from(probe.data, 'base64').readUInt32BE(16) / 40;
      this._compositorScaleFor = s;
    }
    const res = await this.cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s, scale: s / this._compositorScale } });
    const buf = Buffer.from(res.data, 'base64');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (Math.abs(w - r.width) > 1 || Math.abs(h - r.height) > 1) throw new Error(`capture came out ${w}×${h}, expected ${r.width}×${r.height} (scale ${s})`);
    return buf;
  }

  /** Screenshot of a region at physical resolution. Returns the PNG buffer; writes `file` if given (and a zoomed copy). */
  async shot({ region = 'tray', file, zoom = 1 } = {}) {
    const buf = await this.capture(await this.region(region));
    if (file) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buf);
      if (zoom > 1) await zoomPng(file, file.replace(/\.png$/i, `@${zoom}x.png`), zoom);
    }
    return buf;
  }

  /** Starts recording: every advance() is split into frames of 1000/fps ms and each frame is captured. */
  async startRecording({ dir, fps = 30, region = 'tray' }) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const clip = await this.region(region);
    const rec = { dir, fps, clip, n: 0, sinceLast: 0 };
    const frameMs = 1000 / fps;
    rec.capture = async () => {
      const buf = await this.capture(rec.clip);
      await writeFile(path.join(dir, `f${String(rec.n++).padStart(5, '0')}.png`), buf);
    };
    // Frames are captured exactly every frameMs of virtual time, however advance() calls are split.
    rec.advance = async (ms) => {
      let remaining = ms;
      while (rec.sinceLast + remaining >= frameMs - 1e-9) {
        const step = frameMs - rec.sinceLast;
        await this.eval((d) => window.qt.advance(d), step);
        await rec.capture();
        remaining -= step;
        rec.sinceLast = 0;
      }
      if (remaining > 1e-9) { await this.eval((d) => window.qt.advance(d), remaining); rec.sinceLast += remaining; }
    };
    this.recorder = rec;
    await rec.capture();
    return rec;
  }

  async stopRecording({ mp4, gif, zoom = 1 } = {}) {
    const rec = this.recorder;
    this.recorder = null;
    if (!rec) return null;
    const pattern = path.join(rec.dir, 'f%05d.png');
    const out = { frames: rec.n, fps: rec.fps, dir: rec.dir, seconds: rec.n / rec.fps };
    if (mp4) { await framesToMp4(pattern, rec.fps, mp4, zoom); out.mp4 = mp4; }
    if (gif) { await framesToGif(pattern, rec.fps, gif, zoom); out.gif = gif; }
    return out;
  }

  async close() { await this.browser.close(); }
}

export const fileUrl = (p) => pathToFileURL(p).href;
