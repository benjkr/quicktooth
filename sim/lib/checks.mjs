// `qt-sim test`: every self-check of the simulator's fidelity, plus the behaviour scenarios.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Session } from './session.mjs';
import { parity } from './parity.mjs';
import { menuCheck } from './menucheck.mjs';
import { runScenario } from './scenario.mjs';
import { SIM_DIR } from './browser.mjs';

/** Taskbar element rects measured with UI Automation on the real taskbar (1920×1080, 100 %). */
const UIA_100 = {
  start: [850, 45], taskview: [895, 44], app1: [939, 44], app2: [983, 44], app3: [1027, 44],
  chevron: [1662, 32], 'icon:quicktooth': [1694, 32], input: [1726, 44], network: [1774, 24], volume: [1802, 24], clock: [1834, 70], showDesktop: [1908, 12],
};

async function geometryCheck(log) {
  const s = await Session.open({ settleMs: 300 });
  try {
    const g = await s.eval(() => ({ items: window.qt.shell.geom.items.map((i) => [i.key, i.left, i.right - i.left]), tb: [window.qt.shell.geom.tbTop, window.qt.shell.geom.tbH] }));
    const icon = await s.eval(() => { const r = window.qt.shell.iconSlot(); return [r.x, r.y, r.size, r.size]; });
    const bad = g.items.filter(([k, l, w]) => !UIA_100[k] || UIA_100[k][0] !== l || UIA_100[k][1] !== w);
    const tbOk = g.tb[0] === 1032 && g.tb[1] === 48;
    const iconOk = JSON.stringify(icon) === JSON.stringify([1702, 1048, 16, 16]);
    const ok = bad.length === 0 && tbOk && iconOk;
    log(`${ok ? 'PASS' : 'FAIL'} geometry vs UI Automation at 100 %: ${g.items.length - bad.length}/${g.items.length} elements, taskbar ${g.tb.join('/')} (1032/48), icon image ${icon.join(',')} (1702,1048,16,16)`);
    for (const [k, l, w] of bad) log(`     ${k}: sim ${l}+${w}, real ${UIA_100[k]}`);
    return ok;
  } finally { await s.close(); }
}

/** Max |Δ| between the icon slot in a real screenshot and the app's own pixels composited on the taskbar. */
async function iconPixelDiff(s) {
  const r = await s.locate('icon');
  const exp = await s.eval(() => {
    const qt = window.qt, img = qt.app.shownIcon, bg = qt.shell.T.taskbar;
    const [br, bgc, bb] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
    const out = [];
    for (let i = 0; i < img.data.length; i += 4) { const a = img.data[i + 3]; out.push(Math.round((img.data[i] * a + br * (255 - a)) / 255), Math.round((img.data[i + 1] * a + bgc * (255 - a)) / 255), Math.round((img.data[i + 2] * a + bb * (255 - a)) / 255)); }
    return { size: img.width, px: out };
  });
  const size = exp.size;
  const shot = await s.shot({ region: { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.round(r.right - r.left), height: Math.round(r.bottom - r.top) } });
  const got = await s.eval(async (b64) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
    const c = new OffscreenCanvas(im.width, im.height).getContext('2d'); c.drawImage(im, 0, 0);
    return { w: im.width, h: im.height, data: Array.from(c.getImageData(0, 0, im.width, im.height).data) };
  }, shot.toString('base64'));
  const ox = Math.floor((got.w - size) / 2), oy = Math.floor((got.h - size) / 2);
  let maxD = 0;
  for (let yy = 0; yy < size; yy++) for (let xx = 0; xx < size; xx++) {
    const gi = ((oy + yy) * got.w + ox + xx) * 4, ei = (yy * size + xx) * 3;
    for (let c = 0; c < 3; c++) maxD = Math.max(maxD, Math.abs(got.data[gi + c] - exp.px[ei + c]));
  }
  return { maxD, size, w: got.w, h: got.h };
}

/** The icon slot in a real screenshot must be exactly the app's pixels — at every scale, and after a runtime DPI change. */
async function pixelCheck(log) {
  let ok = true;
  for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
    for (const connected of [false, true]) {
      const s = await Session.open({ scale, connected, cursor: false, settleMs: 300 });
      try {
        const d = await iconPixelDiff(s);
        const pass = d.maxD <= 1;
        ok &&= pass;
        log(`${pass ? 'PASS' : 'FAIL'} pixels at ${String(scale * 100).padStart(3)} % ${connected ? 'connected   ' : 'disconnected'}: ${d.size}px icon in a ${d.w}×${d.h} button, max |Δ| vs the app's pixels ${d.maxD}`);
      } finally { await s.close(); }
    }
  }
  for (const seq of [[1, 1.25], [1, 1.75], [1.5, 1], [2, 1.25, 1.5]]) {
    const s = await Session.open({ scale: seq[0], connected: true, cursor: false, settleMs: 300 });
    try {
      for (const to of seq.slice(1)) { await s.eval((x) => window.qt.setScale(x), to); await s.advance(100); }
      const st = await s.state();
      const d = await iconPixelDiff(s);
      const pass = d.maxD <= 1 && st.shell.dpr === seq.at(-1) && st.app.iconSize === d.size;
      ok &&= pass;
      log(`${pass ? 'PASS' : 'FAIL'} pixels after a DPI change ${seq.map((x) => `${x * 100} %`).join(' → ')}: devicePixelRatio ${st.shell.dpr}, ${d.size}px icon, max |Δ| ${d.maxD}`);
    } finally { await s.close(); }
  }
  return ok;
}

export async function runChecks({ outDir, build = true, skipParity = false, log = console.log }) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  const section = (t) => log(`\n== ${t}`);

  if (!skipParity) {
    section('icon renderer vs QuickTooth.exe --render-icons');
    try { results.push(['parity', (await parity({ outDir: path.join(outDir, 'parity'), build, log })).ok]); }
    catch (e) { log(`FAIL parity: ${e.message}`); results.push(['parity', false]); }
  }
  section('menu vs real Win32 menu captures');
  results.push(['menu', (await menuCheck({ outDir: path.join(outDir, 'menu'), log })).ok]);
  section('taskbar geometry');
  results.push(['geometry', await geometryCheck(log)]);
  section('physical-pixel integrity of the tray icon');
  results.push(['pixels', await pixelCheck(log)]);

  section('behaviour scenarios');
  const dir = path.join(SIM_DIR, 'scenarios');
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json')).sort()) {
    const scenario = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    if (!scenario.steps?.some((s) => s.expect || s.waitFor)) continue;
    if (scenario.record) scenario.record = null; // tests don't need video
    const quiet = [];
    const r = await runScenario(scenario, { outDir: path.join(outDir, 'scenarios'), log: (l) => quiet.push(l) });
    log(`${r.ok ? 'PASS' : 'FAIL'} ${scenario.name}${scenario.description ? ` — ${scenario.description}` : ''}`);
    if (!r.ok) { for (const x of r.failures) log('     ✗ ' + x); log('     steps:\n' + quiet.join('\n')); }
    results.push([`scenario:${scenario.name}`, r.ok]);
  }

  const failed = results.filter(([, ok]) => !ok);
  log(`\n${failed.length ? 'FAILED' : 'ALL PASSED'}: ${results.length - failed.length}/${results.length} checks${failed.length ? ` (failed: ${failed.map(([n]) => n).join(', ')})` : ''}`);
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(results, null, 1));
  return { ok: failed.length === 0, results };
}
