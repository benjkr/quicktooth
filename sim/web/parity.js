// Re-creates the sheets that QuickTooth.exe --render-icons writes (IconRenderer.WriteCheckImages),
// pixel for pixel in layout, using the JS renderer — so the two can be diffed.
import { compositeOver } from './icon.js';

const DARK_BG = '#1C1C1C', LIGHT_BG = '#EEEEEE';
const THEMES = [{ name: 'dark', light: false, bg: DARK_BG }, { name: 'light', light: true, bg: LIGHT_BG }];

function blit(dst, dw, src, x0, y0) {
  for (let y = 0; y < src.height; y++)
    dst.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), ((y0 + y) * dw + x0) * 4);
}

function fill(dst, dw, x0, y0, w, h, hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * dw + x) * 4; dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = 255; }
}

/** tray-check-1x.png: both states on both taskbars at 16/20/24/32 px. */
export function staticSheet(R) {
  const sizes = [16, 20, 24, 32], pad = 8;
  const cellW = sizes.reduce((a, b) => a + b) + pad * (sizes.length + 1);
  const rowH = Math.max(...sizes) + pad * 2;
  const width = cellW * THEMES.length, height = rowH * 2;
  const px = new Uint8ClampedArray(width * height * 4);
  THEMES.forEach((th, t) => {
    fill(px, width, t * cellW, 0, cellW, height, th.bg);
    ['connected', 'disconnected'].forEach((state, s) => {
      let x0 = t * cellW + pad;
      for (const size of sizes) {
        const y0 = s * rowH + pad + Math.floor((Math.max(...sizes) - size) / 2);
        blit(px, width, compositeOver(R.renderStatic(state, th.light, size), th.bg), x0, y0);
        x0 += size + pad;
      }
    });
  });
  return new ImageData(px, width, height);
}

/** anim-frames-1x.png: connecting / landing / disconnecting rows per theme, at AnimFrameMs steps. */
export function animSheet(R) {
  const P = R.P;
  const fs = 16, fpad = 4, cols = 17;
  const ft = P.AnimFrameMs / 1000;
  const rows = [];
  for (const th of THEMES) {
    rows.push({ th, phase: 'Connecting', frames: cols, offset: 0 });
    rows.push({ th, phase: 'Landing', frames: Math.ceil(P.LandSeconds / ft) + 1, offset: 1.4 });
    rows.push({ th, phase: 'Disconnecting', frames: Math.ceil((P.DisconnectSeconds + 0.4) / ft), offset: 0 });
  }
  const fw = cols * (fs + fpad) + fpad, fh = rows.length * (fs + fpad) + fpad;
  const px = new Uint8ClampedArray(fw * fh * 4);
  for (let y = 0; y < fh; y++) fill(px, fw, 0, y, fw, 1, y < Math.floor(fh / 2) ? DARK_BG : LIGHT_BG);
  rows.forEach((row, r) => {
    for (let f = 0; f < Math.min(row.frames, cols); f++) {
      const t = f * ft;
      const img = R.renderAnim(row.phase, t, row.offset + t, row.th.light, fs);
      blit(px, fw, compositeOver(img, row.th.bg), fpad + f * (fs + fpad), fpad + r * (fs + fpad));
    }
  });
  const cells = [];
  rows.forEach((row, r) => {
    for (let f = 0; f < Math.min(row.frames, cols); f++)
      cells.push({ label: `${row.th.name} ${row.phase} frame ${f} (t=${(f * ft).toFixed(3)} s)`, x: fpad + f * (fs + fpad), y: fpad + r * (fs + fpad), w: fs, h: fs, bg: row.th.bg });
  });
  return { image: new ImageData(px, fw, fh), rows: rows.map((r) => `${r.th.name} ${r.phase} ×${Math.min(r.frames, cols)}`), cells };
}

/**
 * Per-frame comparison, split into the left and right earbud (cell halves). Anti-aliasing noise
 * barely moves an earbud's ink mass or its centre of mass; a wrong pose, ease, zoom or tracer does.
 */
export function compareCells(ref, sim, cells) {
  const lum = (d, i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
  let worstShift = { v: 0 }, worstMass = { v: 0 }, worstMean = { v: 0 };
  for (const c of cells) {
    const bg = parseInt(c.bg.slice(1, 3), 16);
    let cellSum = 0;
    for (const half of [0, 1]) {
      const x0 = c.x + half * (c.w / 2), x1 = x0 + c.w / 2;
      const m = [ref, sim].map((im) => {
        let mass = 0, mx = 0, my = 0;
        for (let y = c.y; y < c.y + c.h; y++) for (let x = x0; x < x1; x++) {
          const ink = Math.abs(lum(im.data, (y * im.width + x) * 4) - bg) / 255;
          mass += ink; mx += ink * x; my += ink * y;
        }
        return { mass, cx: mass ? mx / mass : 0, cy: mass ? my / mass : 0 };
      });
      for (let y = c.y; y < c.y + c.h; y++) for (let x = x0; x < x1; x++) {
        const i = (y * ref.width + x) * 4;
        cellSum += Math.abs(lum(ref.data, i) - lum(sim.data, i));
      }
      const side = half ? 'right' : 'left';
      const shift = Math.hypot(m[0].cx - m[1].cx, m[0].cy - m[1].cy);
      const massRel = Math.abs(m[0].mass - m[1].mass) / Math.max(1, m[0].mass);
      if (shift > worstShift.v) worstShift = { v: shift, where: `${c.label}, ${side} bud` };
      if (massRel > worstMass.v) worstMass = { v: massRel, where: `${c.label}, ${side} bud` };
    }
    const mean = cellSum / (c.w * c.h);
    if (mean > worstMean.v) worstMean = { v: mean, where: c.label };
  }
  return { worstCentroidShiftPx: worstShift, worstMassDiff: worstMass, worstFrameMeanAbs: worstMean };
}

async function decodePng(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = new OffscreenCanvas(img.width, img.height).getContext('2d');
  c.drawImage(img, 0, 0);
  return c.getImageData(0, 0, img.width, img.height);
}

/** Per-pixel comparison. Returns stats and a side-by-side image: reference | simulator | |diff| × 4. */
export async function compare(refDataUrl, sim, zoom = 6, cells = null) {
  const ref = await decodePng(refDataUrl);
  const cellStats = cells && ref.width === sim.width && ref.height === sim.height ? compareCells(ref, sim, cells) : null;
  if (ref.width !== sim.width || ref.height !== sim.height)
    return { ok: false, error: `size mismatch: reference ${ref.width}×${ref.height}, simulator ${sim.width}×${sim.height}` };
  const n = ref.width * ref.height;
  let sum = 0, max = 0, over8 = 0, over24 = 0;
  const diffs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.max(Math.abs(ref.data[i * 4] - sim.data[i * 4]), Math.abs(ref.data[i * 4 + 1] - sim.data[i * 4 + 1]), Math.abs(ref.data[i * 4 + 2] - sim.data[i * 4 + 2]));
    diffs[i] = d; sum += d; if (d > max) max = d; if (d > 8) over8++; if (d > 24) over24++;
  }
  const sorted = Array.from(diffs).sort((a, b) => a - b);
  const W = ref.width, H = ref.height;
  const out = new OffscreenCanvas(W * 3 * zoom + 2 * zoom, H * zoom);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(0, 0, out.width, out.height);
  const diffImg = new ImageData(W, H);
  for (let i = 0; i < n; i++) { const v = Math.min(255, diffs[i] * 4); diffImg.data[i * 4] = v; diffImg.data[i * 4 + 1] = v * 0.4; diffImg.data[i * 4 + 2] = 0; diffImg.data[i * 4 + 3] = 255; }
  for (const [k, im] of [[0, ref], [1, sim], [2, diffImg]]) {
    const c = new OffscreenCanvas(W, H); c.getContext('2d').putImageData(im, 0, 0);
    ctx.drawImage(c, k * (W * zoom + zoom), 0, W * zoom, H * zoom);
  }
  const blob = await out.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return {
    ok: true, width: W, height: H,
    meanAbs: sum / n, max, p99: sorted[Math.floor(n * 0.99)], p999: sorted[Math.floor(n * 0.999)],
    over8: over8 / n, over24: over24 / n,
    ...(cellStats ?? {}),
    sideBySidePng: btoa(bin),
  };
}
