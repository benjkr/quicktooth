#!/usr/bin/env node
// qt-sim — the QuickTooth taskbar simulator's command line. See sim/README.md.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Session, DEFAULTS } from './lib/session.mjs';
import { runScenario } from './lib/scenario.mjs';
import { parity } from './lib/parity.mjs';
import { menuCheck } from './lib/menucheck.mjs';
import { launch, SIM_DIR } from './lib/browser.mjs';
import { framesToGif, hasFfmpeg, stackPngs } from './lib/ffmpeg.mjs';
import { runChecks } from './lib/checks.mjs';

const HELP = `qt-sim — Windows 11 taskbar + QuickTooth tray simulator (Playwright Chromium)

  node qt-sim.mjs shot      [steps…] [--region tray|screen|taskbar|icon|x,y,w,h] [--zoom N] [--out file.png]
  node qt-sim.mjs run       <scenario.json|name> [--out dir] [--headed]
  node qt-sim.mjs frames    [--phase all|Connecting|Landing|Disconnecting|Cancelling] [--size 16] [--zoom 8] [--compare] [--out dir]
  node qt-sim.mjs parity    [--no-build] [--out dir]       icon renderer vs the real QuickTooth.exe --render-icons
  node qt-sim.mjs menu-check [--out dir]                   menu vs real Win32 menu captures
  node qt-sim.mjs test      [--no-build] [--skip-parity]   everything: parity, menu, geometry, pixels, scenarios
  node qt-sim.mjs open      [options]                      interactive window with a control panel
  node qt-sim.mjs doctor                                   show the browser in use

Steps (shot), applied in order:  --hover icon  --click icon  --rclick icon  --wait 600  --key Escape
                                 --cli --toggle  --bt externalConnect,"AirPods Pro"  --tune-step Travel=2.4
Targets: icon | chevron | clock | menu:<label> | x,y (physical px)

Options (all commands that open the simulator):
  --scale 1|1.25|1.5|1.75|2   --screen 1920x1080   --theme dark|light   --style solid|acrylic
  --profile fast|typical|slow|flaky|unreachable|rejected|long-linger|windows-a2dp-first   --seed N
  --connected   --first-run   --overflow   --no-cursor   --no-dwm   --timer-quantum 15.625 (0 = exact timers)
  --tune Name=value,Name=value (or JSON; src/QuickTooth.Core/Tunables.cs names)   --settle ms (default 1500)
`;

/** --tune takes JSON or, shell-quoting-free, Name=value,Name=value. */
function parseTune(v) {
  if (v.trim().startsWith('{')) return JSON.parse(v);
  return Object.fromEntries(v.split(',').filter(Boolean).map((kv) => {
    const [k, val] = kv.split('=');
    if (val === undefined) throw new Error(`--tune: expected Name=value, got "${kv}"`);
    return [k.trim(), Number(val)];
  }));
}

function parseArgs(argv) {
  const pos = [], opt = {}, steps = [];
  const stepFlags = { hover: 'hover', click: 'click', rclick: 'rightClick', wait: 'wait', key: 'key', cli: 'cli', bt: 'bt', 'profile-step': 'profile', 'theme-step': 'theme', 'scale-step': 'scale', 'tune-step': 'tune', move: 'move' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    const next = () => argv[++i];
    if (k in stepFlags) {
      let v = next();
      if (k === 'wait') v = Number(v);
      else if (k === 'bt') v = v.split(',').map((x) => (/^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x === 'true' ? true : x === 'false' ? false : x));
      else if (k === 'tune-step') v = parseTune(v);
      else if (k === 'scale-step') v = Number(v);
      steps.push({ [stepFlags[k]]: v });
      continue;
    }
    const bools = ['connected', 'first-run', 'overflow', 'no-cursor', 'no-dwm', 'no-build', 'skip-parity', 'headed', 'compare', 'panel', 'json'];
    const values = ['scale', 'screen', 'theme', 'style', 'profile', 'seed', 'timer-quantum', 'tune', 'variant', 'settle', 'region', 'zoom', 'out', 'phase', 'size'];
    if (bools.includes(k)) { opt[k] = true; continue; }
    // A typo must not quietly produce a confident, wrong screenshot.
    if (!values.includes(k)) throw new Error(`unknown option --${k} (see: node qt-sim.mjs help)`);
    const v = next();
    if (v === undefined) throw new Error(`--${k} needs a value`);
    opt[k] = v;
  }
  return { pos, opt, steps };
}

function sessionOpts(opt) {
  const o = {};
  if (opt.scale) o.scale = Number(opt.scale);
  if (opt.screen) o.screen = opt.screen;
  if (opt.theme) o.theme = opt.theme;
  if (opt.style) o.style = opt.style;
  if (opt.profile) o.profile = opt.profile;
  if (opt.seed) o.seed = Number(opt.seed);
  if (opt.connected) o.connected = true;
  if (opt['first-run']) o.firstRun = true;
  if (opt.overflow) o.overflow = true;
  if (opt['no-cursor']) o.cursor = false;
  if (opt['no-dwm']) o.dwm = false;
  if (opt['timer-quantum'] != null) o.timerQuantum = Number(opt['timer-quantum']);
  if (opt.tune) o.tune = parseTune(opt.tune);
  if (opt.variant) o.variant = opt.variant;
  if (opt.settle != null) o.settleMs = Number(opt.settle);
  return o;
}

async function loadScenario(arg) {
  const candidates = [arg, path.join(SIM_DIR, 'scenarios', arg), path.join(SIM_DIR, 'scenarios', arg + '.json')];
  for (const c of candidates) { try { return { file: c, scenario: JSON.parse(await readFile(c, 'utf8')) }; } catch { /* next */ } }
  const names = (await readdir(path.join(SIM_DIR, 'scenarios'))).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  throw new Error(`scenario "${arg}" not found. Built-in: ${names.join(', ')}`);
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const { pos, opt, steps } = parseArgs(rest);
  const out = path.resolve(opt.out ?? path.join(SIM_DIR, 'out'));

  switch (cmd) {
    case 'shot': {
      const file = opt.out?.endsWith('.png') ? path.resolve(opt.out) : path.join(out, 'shot.png');
      const s = await Session.open(sessionOpts(opt));
      try {
        for (const step of steps) {
          const [k] = Object.keys(step); const v = step[k];
          if (k === 'hover' || k === 'move') await s.moveTo(v);
          else if (k === 'click') await s.click(v);
          else if (k === 'rightClick') await s.click(v, { button: 'right' });
          else if (k === 'wait') await s.advance(v);
          else if (k === 'key') { await s.page.keyboard.press(v); await s.eval(() => window.qt.clock.settle()); }
          else if (k === 'cli') { await s.eval((a) => window.qt.cli(a), v); await s.eval(() => window.qt.clock.settle()); }
          else if (k === 'bt') { await s.eval(([fn, args]) => window.qt.bt[fn](...args), [v[0], v.slice(1)]); await s.eval(() => window.qt.clock.settle()); }
          else if (k === 'profile') await s.eval((p) => window.qt.profile(p), v);
          else if (k === 'theme') await s.eval((t) => window.qt.setTheme(t), v);
          else if (k === 'scale') await s.eval((x) => window.qt.setScale(x), v);
          else if (k === 'tune') await s.eval((o) => window.qt.tune(o), v);
        }
        await s.shot({ region: opt.region ?? 'tray', file, zoom: Number(opt.zoom ?? 1) });
        const st = await s.state();
        console.log(file + (Number(opt.zoom ?? 1) > 1 ? `\n${file.replace(/\.png$/i, `@${opt.zoom}x.png`)}` : ''));
        console.log(`t=${(st.t / 1000).toFixed(3)}s  tooltip: ${st.app.tooltip}  icon: ${JSON.stringify(st.app.icon)}  pending: ${st.app.pending}${st.shell.menu ? `  menu: ${JSON.stringify(st.shell.menu.map((m) => m.items))}` : ''}`);
        if (opt.json) console.log(JSON.stringify(st, null, 2));
      } finally { await s.close(); }
      break;
    }
    case 'run': {
      if (!pos[0]) throw new Error('usage: qt-sim run <scenario.json|name>');
      const { file, scenario } = await loadScenario(pos[0]);
      console.log(`scenario ${scenario.name ?? path.basename(file)} (${file})`);
      const r = await runScenario(scenario, { outDir: out, overrides: sessionOpts(opt), headless: !opt.headed });
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  → ${r.dir}`);
      for (const f of r.failures) console.log('  ✗ ' + f);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'frames': {
      const phases = !opt.phase || opt.phase === 'all' ? ['Connecting', 'Landing', 'Disconnecting', 'Cancelling'] : [opt.phase];
      const size = Number(opt.size ?? 16), zoom = Number(opt.zoom ?? 8);
      const dir = path.join(out, 'frames');
      await mkdir(dir, { recursive: true });
      const variants = [{ label: 'baseline', o: {} }];
      if (opt.compare || opt.tune || opt.variant) {
        if (opt.compare) variants[0].o = { tune: null, variant: null };
        variants.push({ label: 'variant', o: sessionOpts(opt) });
        if (!opt.compare) variants.shift();
      }
      const sheets = [];
      for (const v of variants) {
        const s = await Session.open({ ...v.o, settleMs: 0 });
        try {
          const res = await s.eval(async ({ phases, size, zoom }) => {
            const qt = window.qt, P = qt.kit.P;
            const step = qt.app.timers.effective(P.AnimFrameMs);
            const plan = { Connecting: [1500, 0], Landing: [P.LandSeconds * 1000 + step, 1.4], Disconnecting: [P.DisconnectSeconds * 1000 + 600, 0], Cancelling: [P.CancelSeconds * 1000 + step, 1.4] };
            const rows = [];
            for (const light of [false, true]) for (const ph of phases) rows.push({ ph, light, frames: qt.frames({ phase: ph, durationMs: plan[ph][0], tracerOffset: plan[ph][1], light, size }) });
            const cols = Math.max(...rows.map((r) => r.frames.length));
            const cell = size * zoom, pad = 6, labelW = 150;
            const c = document.createElement('canvas'); c.width = labelW + cols * (cell + pad) + pad; c.height = rows.length * (cell + pad) + pad + 18;
            const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
            ctx.fillStyle = '#111'; ctx.fillRect(0, 0, c.width, c.height);
            ctx.fillStyle = '#aaa'; ctx.font = '12px Segoe UI'; ctx.fillText(`one frame per timer tick (${step.toFixed(2)} ms), ${size}px icon ×${zoom}`, 8, 13);
            for (const [ri, r] of rows.entries()) {
              const y = 18 + pad + ri * (cell + pad);
              ctx.fillStyle = '#ddd'; ctx.fillText(`${r.ph} (${r.light ? 'light' : 'dark'})`, 8, y + cell / 2 + 4);
              for (const [fi, f] of r.frames.entries()) { const im = new Image(); im.src = f.png; await im.decode(); ctx.drawImage(im, labelW + fi * (cell + pad), y, cell, cell); }
            }
            return { sheet: c.toDataURL(), step, gif: rows.filter((r) => !r.light).map((r) => ({ ph: r.ph, frames: r.frames.map((f) => f.png) })) };
          }, { phases, size, zoom });
          const sheetFile = path.join(dir, `frames-${v.label}.png`);
          await writeFile(sheetFile, Buffer.from(res.sheet.split(',')[1], 'base64'));
          sheets.push(sheetFile);
          console.log(sheetFile);
          if (await hasFfmpeg()) {
            for (const g of res.gif) {
              const fdir = path.join(dir, `${v.label}-${g.ph}`);
              await mkdir(fdir, { recursive: true });
              for (const [i, png] of g.frames.entries()) await writeFile(path.join(fdir, `f${String(i).padStart(5, '0')}.png`), Buffer.from(png.split(',')[1], 'base64'));
              const gif = path.join(dir, `${v.label}-${g.ph}.gif`);
              await framesToGif(path.join(fdir, 'f%05d.png'), (1000 / res.step).toFixed(3), gif, zoom);
              console.log(gif + `   (${g.frames.length} frames at the real ${res.step.toFixed(1)} ms cadence)`);
            }
          }
        } finally { await s.close(); }
      }
      if (sheets.length === 2 && await hasFfmpeg()) {
        const cmp = path.join(dir, 'frames-compare.png');
        await stackPngs(sheets, cmp, readFile);
        console.log(`${cmp}   (baseline above, variant below)`);
      }
      break;
    }
    case 'parity': {
      const r = await parity({ outDir: path.join(out, 'parity'), build: !opt['no-build'] });
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'menu-check': {
      const r = await menuCheck({ outDir: path.join(out, 'menu-check') });
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'test': {
      const r = await runChecks({ outDir: path.join(out, 'test'), build: !opt['no-build'], skipParity: !!opt['skip-parity'] });
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'open': {
      const o = { ...sessionOpts(opt), panel: true, mode: 'realtime', settleMs: 0, headless: false };
      if (!opt.screen) o.screen = '1280x720';
      const s = await Session.open(o);
      console.log('Simulator open. Close the window (or press Ctrl+C) to quit.');
      await new Promise((resolve) => { s.page.on('close', resolve); s.browser.on('disconnected', resolve); process.on('SIGINT', resolve); });
      await s.browser.close().catch(() => {});
      break;
    }
    case 'doctor': {
      const { browser, executable, version } = await launch({ viewport: { width: 100, height: 100 } });
      console.log(`browser: Chromium ${version} (Playwright channel "chromium")\nexecutable: ${executable}\nffmpeg: ${(await hasFfmpeg()) ? 'found' : 'missing (needed for video/GIF and --zoom)'}`);
      await browser.close();
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
