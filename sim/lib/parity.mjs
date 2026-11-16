// `qt-sim parity`: renders the icon check sheets with the real app (QuickTooth.exe --render-icons)
// and with the simulator's JS port, then diffs them pixel by pixel. Fails if they drift apart.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { launch, ORIGIN, REPO_ROOT } from './browser.mjs';

const run = promisify(execFile);

// The simulator draws with the app's own C# renderer (src/QuickTooth.Core, compiled to WebAssembly),
// so the sheets should match QuickTooth.exe's to within 1 level: the only differences come from
// the browser's and Windows' maths libraries (sin/cos/pow) rounding a few edge pixels the other way.
// Measured (Nov 2026): static mean |Δ| 0.03, anim 0.05, max 1 in both.
export const THRESHOLDS = {
  static: { meanAbs: 0.15, p99: 1, max: 1 },
  anim: { meanAbs: 0.15, p99: 1, max: 1, worstFrameMeanAbs: 0.6, worstCentroidShiftPx: 0.03, worstMassDiff: 0.015 },
};

function check(name, r) {
  const t = THRESHOLDS[name], failures = [];
  for (const [k, limit] of Object.entries(t)) {
    const v = typeof r[k] === 'object' ? r[k].v : r[k];
    if (v > limit) failures.push(`${k} ${v.toFixed(3)} > ${limit}${r[k]?.where ? ` (${r[k].where})` : ''}`);
  }
  return failures;
}

// What `dotnet build -c Release` produces (publish.ps1 stages a native build under bin\publish).
const BUILT_EXE = path.join(REPO_ROOT, 'src', 'QuickTooth', 'bin', 'Release', 'net10.0-windows10.0.19041.0', 'win-x64', 'QuickTooth.exe');

async function findExe(justBuilt) {
  if (justBuilt && await stat(BUILT_EXE).catch(() => null)) return BUILT_EXE;
  const base = path.join(REPO_ROOT, 'src', 'QuickTooth', 'bin');
  const hits = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.toLowerCase() === 'quicktooth.exe') hits.push({ p, t: (await stat(p)).mtimeMs });
    }
  }
  await walk(base);
  hits.sort((a, b) => b.t - a.t);
  return hits[0]?.p;
}

export async function parity({ outDir, build = true, exe, log = console.log }) {
  await mkdir(outDir, { recursive: true });
  if (!exe) {
    if (build) {
      log('building src/QuickTooth (Release)…');
      // Build only: publish.ps1 would install and start the tray app.
      await run('dotnet', ['build', path.join(REPO_ROOT, 'src/QuickTooth/QuickTooth.csproj'), '-c', 'Release', '-nologo', '-v', 'q'], { cwd: REPO_ROOT, windowsHide: true, maxBuffer: 1 << 24 });
    }
    exe = await findExe(build);
    if (!exe) throw new Error('QuickTooth.exe not found under src/QuickTooth/bin; build it first (dotnet build src/QuickTooth -c Release)');
  }
  const refDir = path.join(os.tmpdir(), `qt-sim-parity-${process.pid}`);
  await mkdir(refDir, { recursive: true });
  log(`real renderer: ${path.relative(REPO_ROOT, exe)} --render-icons`);
  // --render-icons is a CLI mode: draws to PNGs and exits; it never starts the tray.
  await run(exe, ['--render-icons', refDir], { windowsHide: true });

  const sheets = [
    { name: 'static', file: 'tray-check-1x.png' },
    { name: 'anim', file: 'anim-frames-1x.png' },
  ];
  const refs = {};
  for (const s of sheets) refs[s.name] = 'data:image/png;base64,' + (await readFile(path.join(refDir, s.file))).toString('base64');

  const { browser, page, version } = await launch({ viewport: { width: 400, height: 300 } });
  try {
    await page.goto(`${ORIGIN}/sim/web/blank.html`);
    const result = await page.evaluate(async (refs) => {
      const { loadKit } = await import('/sim/web/kit.js');
      const { staticSheet, animSheet, compare } = await import('/sim/web/parity.js');
      const kit = await loadKit();
      const anim = animSheet(kit.renderer);
      return {
        warnings: kit.warnings,
        rows: anim.rows,
        static: await compare(refs.static, staticSheet(kit.renderer), 4),
        anim: await compare(refs.anim, anim.image, 6, anim.cells),
      };
    }, refs);
    log(`chromium ${version}`);
    for (const w of result.warnings) log('warning: ' + w);
    let ok = true;
    const report = { thresholds: THRESHOLDS, sheets: {} };
    for (const s of sheets) {
      const r = result[s.name];
      if (!r.ok) { log(`${s.name}: ${r.error}`); ok = false; continue; }
      const failures = check(s.name, r);
      const pass = failures.length === 0;
      ok &&= pass;
      const png = path.join(outDir, `parity-${s.name}.png`);
      await writeFile(png, Buffer.from(r.sideBySidePng, 'base64'));
      delete r.sideBySidePng;
      report.sheets[s.name] = { ...r, pass, failures, image: png };
      const frames = r.worstCentroidShiftPx ? `  worst frame: mean ${r.worstFrameMeanAbs.v.toFixed(2)}, centroid ${r.worstCentroidShiftPx.v.toFixed(3)} px, mass ${(r.worstMassDiff.v * 100).toFixed(1)}%` : '';
      log(`${pass ? 'PASS' : 'FAIL'} ${s.name.padEnd(6)} ${r.width}×${r.height}  mean |Δ| ${r.meanAbs.toFixed(2)}  p99 ${r.p99}  max ${r.max}${frames}`);
      for (const f of failures) log('     ' + f);
      log(`     side by side (real | sim | diff): ${png}`);
    }
    report.animRows = result.rows;
    report.ok = ok;
    await writeFile(path.join(outDir, 'parity.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await browser.close();
  }
}
