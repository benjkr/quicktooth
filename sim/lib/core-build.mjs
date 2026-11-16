// Builds the app's shared C# code (src/QuickTooth.Core, via src/QuickTooth.Web) for the browser,
// into sim/web/core, whenever the C# is newer than the last build. Every simulator run goes
// through ensureCore(), so the page never runs stale app code. Needs the .NET 10 SDK; no extra
// workload.
import { execFile } from 'node:child_process';
import { readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT, SIM_DIR } from './browser.mjs';

const run = promisify(execFile);
export const CORE_DIR = path.join(SIM_DIR, 'web', 'core');
const STAMP = path.join(CORE_DIR, 'build.json');
const SOURCES = ['src/QuickTooth.Core', 'src/QuickTooth.Web', 'src/Directory.Build.props', 'src/Directory.Build.targets',
  'assets/airpods-pro-fill.svg', 'assets/airpods-pro-line.svg'];

/** Newest modification time (ms) under the shared sources, ignoring build output. */
async function newestSource() {
  let newest = 0, files = 0;
  async function visit(p) {
    const s = await stat(p).catch(() => null);
    if (!s) return;
    if (s.isDirectory()) {
      const base = path.basename(p);
      if (base === 'bin' || base === 'obj') return;
      for (const e of await readdir(p)) await visit(path.join(p, e));
    } else {
      files++;
      newest = Math.max(newest, s.mtimeMs);
    }
  }
  for (const rel of SOURCES) await visit(path.join(REPO_ROOT, rel));
  return { newest, files };
}

async function gitDescribe() {
  try {
    const { stdout: head } = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, windowsHide: true });
    const { stdout: dirty } = await run('git', ['status', '--porcelain', '--', ...SOURCES], { cwd: REPO_ROOT, windowsHide: true });
    return head.trim() + (dirty.trim() ? '+local changes' : '');
  } catch {
    return 'unknown commit';
  }
}

/**
 * Makes sure sim/web/core holds a build of the current C#. Returns { built, label, ms }.
 * @param {{ log?: (line:string)=>void, force?: boolean }} [o]
 */
export async function ensureCore({ log = console.log, force = false } = {}) {
  const src = await newestSource();
  const stamp = JSON.parse(await readFile(STAMP, 'utf8').catch(() => 'null'));
  const label = await gitDescribe();
  if (!force && stamp && stamp.sourceMtime >= src.newest && stamp.sourceFiles === src.files) {
    log(`app core: C# build from ${stamp.label}, ${new Date(stamp.builtAt).toLocaleString()} (up to date)`);
    return { built: false, label: stamp.label, ms: 0 };
  }
  log(`app core: building src/QuickTooth.Web for the browser (${label})…`);
  const t0 = Date.now();
  await rm(CORE_DIR, { recursive: true, force: true });
  try {
    await run('dotnet', ['publish', path.join(REPO_ROOT, 'src/QuickTooth.Web/QuickTooth.Web.csproj'), '-c', 'Release', '-nologo', '-v', 'q', '-o', CORE_DIR],
      { cwd: REPO_ROOT, windowsHide: true, maxBuffer: 1 << 26 });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.split(/\r?\n/).filter((l) => /error|warning/i.test(l)).slice(0, 20).join('\n');
    throw new Error(`building the C# core for the browser failed:\n${out || e.message}`);
  }
  const ms = Date.now() - t0;
  await writeFile(STAMP, JSON.stringify({ label, builtAt: Date.now(), sourceMtime: src.newest, sourceFiles: src.files }, null, 1));
  log(`app core: built in ${(ms / 1000).toFixed(1)} s`);
  return { built: true, label, ms };
}
