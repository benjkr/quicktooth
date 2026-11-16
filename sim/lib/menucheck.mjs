// `qt-sim menu-check`: renders the menu the probe captured (sim/reference/probe/menuprobe.cs) with
// the simulator's menu code and compares it with the real captures in sim/reference/menu:
// window sizes, item rects, placement for three anchors, and pixels outside the text.
// (GDI ClearType text and Chromium text never match pixel for pixel, so text is compared by its
// ink box instead.)
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launch, ORIGIN, SIM_DIR } from './browser.mjs';

const REF = path.join(SIM_DIR, 'reference', 'menu');

export async function menuCheck({ outDir, log = console.log }) {
  await mkdir(outDir, { recursive: true });
  const files = await readdir(REF);
  const reports = {};
  for (const f of files.filter((x) => x.endsWith('.json'))) reports[f.replace('.json', '')] = JSON.parse(await readFile(path.join(REF, f), 'utf8'));
  const pngs = {};
  for (const f of files.filter((x) => x.endsWith('.png'))) pngs[f] = 'data:image/png;base64,' + (await readFile(path.join(REF, f))).toString('base64');

  const { browser, page } = await launch({ viewport: { width: 400, height: 300 } });
  try {
    await page.goto(`${ORIGIN}/sim/web/blank.html`);
    const res = await page.evaluate(async ({ reports, pngs }) => {
      const M = await import('/sim/web/menu.js');
      const items = [
        { id: 9, text: 'AirPods Pro — Connected · 80%', grayed: true }, { separator: true }, { id: 2, text: 'Disconnect' },
        { text: 'Device', submenu: [{ id: 100, text: 'AirPods Pro  (connected)', checked: true }, { id: 101, text: 'Other Headset' }] },
        { separator: true }, { id: 3, text: 'Start with Windows', checked: true }, { id: 4, text: 'Exit' },
      ];
      const screen = { width: 1920, height: 1080 };
      const main = M.layoutMenu(items, 1), sub = M.layoutMenu(items[3].submenu, 1);
      const out = { geometry: [], pixels: [] };
      // Geometry vs every probe run.
      for (const [tag, rep] of Object.entries(reports)) {
        const [ax, ay] = rep.anchor;
        const pos = M.placeMainMenu(main, ax, ay, screen);
        const real = rep.scenes[0].windows[0].rect;
        const sim = [pos.left, pos.top, pos.left + main.width, pos.top + main.height];
        const realItems = rep.scenes[0].items;
        const simItems = main.rows.map((r) => [pos.left + 3, pos.top + r.top, pos.left + main.width - 3, pos.top + r.top + r.height]);
        const subScene = rep.scenes.find((s) => s.scene === 'submenu-open');
        const realSub = subScene.windows.find((w) => w.rect[2] - w.rect[0] !== real[2] - real[0])?.rect;
        const sp = M.placeSubmenu(sub, pos, main, main.rows[3], screen, 1);
        const simSub = [sp.left, sp.top, sp.left + sub.width, sp.top + sub.height];
        out.geometry.push({ tag, real, sim, items: JSON.stringify(realItems) === JSON.stringify(simItems), realSub, simSub });
      }
      // Pixels vs the captures (rclick-mid set; all anchors render identically).
      const decode = async (url) => { const im = new Image(); im.src = url; await im.decode(); const c = new OffscreenCanvas(im.width, im.height).getContext('2d'); c.drawImage(im, 0, 0); return c.getImageData(0, 0, im.width, im.height); };
      const scenes = [
        ['idle-0', main, -1], ['hot-disconnect-0', main, 2], ['hot-header-disabled-0', main, 0],
        ['submenu-open-1', main, 3], ['submenu-open-0', sub, -1], ['submenu-hot-0', sub, 1],
      ];
      for (const theme of ['dark', 'light']) {
        for (const [scene, lay, hot] of scenes) {
          const key = `${theme}-rclick-mid-${scene}.png`;
          const ref = await decode(pngs[key]);
          const c = new OffscreenCanvas(lay.width, lay.height);
          const ctx = c.getContext('2d');
          M.drawMenu(ctx, lay, { theme, hot });
          const sim = ctx.getImageData(0, 0, lay.width, lay.height);
          const sameSize = ref.width === sim.width && ref.height === sim.height;
          let n = 0, sum = 0, max = 0, textInkRef = [Infinity, -Infinity], textInkSim = [Infinity, -Infinity];
          if (sameSize) {
            // Text boxes: from textX−3 to the end of the text + 3, rows of each item.
            const mask = new Uint8Array(lay.width * lay.height);
            const mctx = new OffscreenCanvas(8, 8).getContext('2d'); mctx.font = `${lay.fontPx}px ${M.MENU_METRICS.font}`;
            for (const row of lay.rows) if (!row.separator) {
              const w = mctx.measureText(row.text).width;
              for (let y = row.top + 3; y < row.top + row.height - 3; y++) for (let x = M.MENU_METRICS.textX - 3; x < Math.min(lay.width, M.MENU_METRICS.textX + w + 6); x++) mask[y * lay.width + x] = 1;
            }
            const bgL = (im, i) => (im.data[i] + im.data[i + 1] + im.data[i + 2]) / 3;
            for (let p = 0; p < mask.length; p++) {
              const i = p * 4;
              if (mask[p]) {
                // ink extent along x for the text rows (both images)
                const x = p % lay.width;
                const refInk = Math.abs(bgL(ref, i) - bgL(ref, (Math.floor(p / lay.width) * lay.width + lay.width - 12) * 4)) > 60;
                const simInk = Math.abs(bgL(sim, i) - bgL(sim, (Math.floor(p / lay.width) * lay.width + lay.width - 12) * 4)) > 60;
                if (refInk) { textInkRef[0] = Math.min(textInkRef[0], x); textInkRef[1] = Math.max(textInkRef[1], x); }
                if (simInk) { textInkSim[0] = Math.min(textInkSim[0], x); textInkSim[1] = Math.max(textInkSim[1], x); }
                continue;
              }
              const d = Math.max(Math.abs(ref.data[i] - sim.data[i]), Math.abs(ref.data[i + 1] - sim.data[i + 1]), Math.abs(ref.data[i + 2] - sim.data[i + 2]));
              n++; sum += d; if (d > max) max = d;
            }
          }
          // side-by-side image (ref | sim) at 3×
          const z = 3, W = Math.max(ref.width, sim.width), H = Math.max(ref.height, sim.height);
          const sb = new OffscreenCanvas((W * 2 + 4) * z, H * z), sctx = sb.getContext('2d');
          sctx.imageSmoothingEnabled = false; sctx.fillStyle = '#f0f'; sctx.fillRect(0, 0, sb.width, sb.height);
          for (const [k, im] of [[0, ref], [1, sim]]) { const t = new OffscreenCanvas(im.width, im.height); t.getContext('2d').putImageData(im, 0, 0); sctx.drawImage(t, k * (W + 4) * z, 0, im.width * z, im.height * z); }
          const blob = await sb.convertToBlob({ type: 'image/png' });
          const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          out.pixels.push({ theme, scene, ref: [ref.width, ref.height], sim: [sim.width, sim.height], sameSize, meanAbsNonText: n ? sum / n : null, maxNonText: max, textInkRef, textInkSim, png: btoa(bin) });
        }
      }
      return out;
    }, { reports, pngs });

    let ok = true;
    log('placement (physical px, 1920×1080 @ 100 %):');
    for (const g of res.geometry) {
      const pass = JSON.stringify(g.real) === JSON.stringify(g.sim) && g.items && JSON.stringify(g.realSub) === JSON.stringify(g.simSub);
      ok &&= pass;
      log(`  ${pass ? 'PASS' : 'FAIL'} ${g.tag.padEnd(24)} menu real ${g.real} sim ${g.sim}  items ${g.items ? 'match' : 'DIFFER'}  submenu real ${g.realSub} sim ${g.simSub}`);
    }
    log('rendering vs WM_PRINT captures (non-text pixels; text compared by ink box):');
    for (const p of res.pixels) {
      const inkOk = Math.abs(p.textInkRef[0] - p.textInkSim[0]) <= 1 && Math.abs(p.textInkRef[1] - p.textInkSim[1]) <= 4;
      const pass = p.sameSize && p.meanAbsNonText <= 1.5 && inkOk;
      ok &&= pass;
      const file = path.join(outDir, `menu-${p.theme}-${p.scene}.png`);
      await writeFile(file, Buffer.from(p.png, 'base64'));
      log(`  ${pass ? 'PASS' : 'FAIL'} ${p.theme.padEnd(5)} ${p.scene.padEnd(22)} size real ${p.ref.join('×')} sim ${p.sim.join('×')}  non-text mean |Δ| ${p.meanAbsNonText?.toFixed(2)} max ${p.maxNonText}  text x ${p.textInkRef.join('–')} vs ${p.textInkSim.join('–')}`);
    }
    log(`side-by-side images (real | sim): ${outDir}`);
    return { ok, ...res, pixels: res.pixels.map(({ png, ...r }) => r) };
  } finally {
    await browser.close();
  }
}
