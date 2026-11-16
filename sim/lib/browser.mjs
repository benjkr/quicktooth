// Launches Playwright's own Chromium (channel "chromium", the full build that ships with
// playwright 1.60.0, revision 1223) — never Chrome or Edge. Repo files are served to the page by
// request interception on a fake origin, so no local web server or port is involved.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'http://qt.sim';
export const SIM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SIM_DIR, '..');

// Only these repo paths are served to the page.
const ALLOW = [/^sim\/web\//, /^sim\/reference\//, /^assets\//, /^src\/QuickTooth\/.+\.cs$/];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.cs': 'text/plain', '.txt': 'text/plain', '.wasm': 'application/wasm', '.dat': 'application/octet-stream' };

async function serve(route, extraFiles) {
  const url = new URL(route.request().url());
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' || rel === 'index.html') rel = 'sim/web/index.html';
  if (extraFiles.has(rel)) {
    const f = extraFiles.get(rel);
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream', body: await readFile(f) });
  }
  const abs = path.resolve(REPO_ROOT, rel);
  if (!abs.startsWith(REPO_ROOT + path.sep) || !ALLOW.some((re) => re.test(rel.replace(/\\/g, '/')))) {
    return route.fulfill({ status: 404, body: `not served: ${rel}` });
  }
  try {
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', body: await readFile(abs), headers: { 'cache-control': 'no-store' } });
  } catch {
    return route.fulfill({ status: 404, body: `missing: ${rel}` });
  }
}

/**
 * @param {object} o
 * @param {boolean} [o.headless=true]
 * @param {number} [o.scale=1] display scale → deviceScaleFactor
 * @param {{width:number,height:number}} o.viewport CSS px (= DIPs)
 * @param {Map<string,string>} [o.extraFiles] extra URL path → absolute file (e.g. a variant module outside the repo)
 */
export async function launch({ headless = true, scale = 1, viewport, extraFiles = new Map(), recordVideo } = {}) {
  // Bun before 1.4.4 hangs in chromium.launch on Windows (the --remote-debugging-pipe never answers).
  if (globalThis.Bun && Bun.semver.order(Bun.version, '1.4.4') < 0) {
    throw new Error(`Bun ${Bun.version} is too old: Playwright's Chromium launch hangs on Windows before Bun 1.4.4. Run \`bun upgrade\`.`);
  }
  // The page runs the app's C# core: rebuild it first if the C# changed (prints which build is used).
  const { ensureCore } = await import('./core-build.mjs');
  await ensureCore({ log: (line) => console.error(line) });
  const browser = await chromium.launch({ channel: 'chromium', headless, args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, recordVideo, colorScheme: 'dark' });
  await context.route(`${ORIGIN}/**`, (route) => serve(route, extraFiles));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}]`, m.text()); });
  return { browser, context, page, executable: chromium.executablePath(), version: browser.version() };
}
