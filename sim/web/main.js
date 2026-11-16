// Boots the simulator page and exposes `window.qt`, the API agents (and qt-sim.mjs) drive it with.
// URL options (all optional):
//   scale=1|1.25|1.5|1.75|2   screen=1920x1080   theme=dark|light   style=solid|acrylic
//   profile=fast|typical|slow|flaky|unreachable|rejected|long-linger|windows-a2dp-first
//   seed=1   mode=realtime|manual   speed=1   connected=0|1   firstRun=0|1   overflow=0|1
//   panel=1|0   cursor=1|0   dwm=1|0   timerQuantum=15.625   tune={"Travel":2.2}
import { SimClock, seededRandom } from './clock.js';
import { loadKit } from './kit.js';
import { MockBluetooth, PROFILES } from './bluetooth.js';
import { TrayAppModel, SimSettings, IPC, EXE_PATH } from './tray.js';
import { Shell } from './shell.js';
import { PHASES, compositeOver } from './icon.js';
import { buildPanel } from './panel.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const bool = (k, d) => (q.has(k) ? q.get(k) !== '0' && q.get(k) !== 'false' : d);
const [sw, sh] = (q.get('screen') ?? '1920x1080').split('x').map(Number);

const config = {
  scale: num('scale', window.devicePixelRatio || 1),
  screen: { width: sw, height: sh },
  theme: q.get('theme') ?? 'dark',
  taskbarStyle: q.get('style') ?? 'solid',
  profile: q.get('profile') ?? 'typical',
  seed: num('seed', 1),
  mode: q.get('mode') ?? 'realtime',
  speed: num('speed', 1),
  connected: bool('connected', false),
  firstRun: bool('firstRun', false),
  overflow: bool('overflow', false),
  panel: bool('panel', true),
  cursor: bool('cursor', true),
  dwm: bool('dwm', true),
  timerQuantumMs: num('timerQuantum', 15.625),
  tune: q.has('tune') ? JSON.parse(q.get('tune')) : {},
  variant: q.get('variant') ?? null,
};

const LOG_PID = 4242;

async function boot() {
  const kit = await loadKit({ overrides: config.tune, variant: config.variant });
  const clock = new SimClock({ mode: config.mode, speed: config.speed });
  const rng = seededRandom(config.seed);
  const bt = new MockBluetooth(clock, rng, { profile: config.profile });
  const airpods = bt.devices[0];
  if (config.connected) { airpods.link = 'up'; for (const e of airpods.endpoints) e.state = 1; }

  document.body.classList.toggle('qt-no-panel', !config.panel);
  const shell = new Shell({ root: document.getElementById('screen'), clock, opts: {
    scale: config.scale, screen: config.screen, theme: config.theme, taskbarStyle: config.taskbarStyle, cursor: config.cursor, dwm: config.dwm,
  } });
  if (Math.abs((window.devicePixelRatio || 1) - config.scale) > 1e-6)
    shell.dom.banner.textContent = `devicePixelRatio is ${window.devicePixelRatio}, but scale=${config.scale}: physical-pixel output will be resampled. Launch through qt-sim so the host sets the DPR.`;
  if (kit.warnings.length) shell.dom.banner.textContent = kit.warnings.join(' · ');

  const logLines = [];
  const timeline = [];
  const epoch = shell.o.epochMs;
  const stamp = (t) => new Date(epoch + t).toISOString().replace('T', ' ').replace('Z', '');
  const log = (msg) => logLines.push({ t: clock.now, line: `${stamp(clock.now)} [${LOG_PID}] ${msg}` });
  const emit = (e) => timeline.push({ t: clock.now, ...e });

  // Settings as they would be on disk: first run = empty; otherwise the AirPods are the saved target
  // and the icon was promoted out of the overflow once before.
  let settings;
  const makeSettings = (firstRun) => firstRun
    ? new SimSettings()
    : new SimSettings({ targetContainerId: airpods.containerId, targetMac: airpods.mac, targetName: airpods.name, trayPromotedOnce: true });
  const autostart = { enabled: false };

  function seedRegistry(firstRun, overflow) {
    shell.registry.entries = [];
    if (!firstRun) { const e = shell.registry.ensure(EXE_PATH, overflow ? 0 : 1); e.created = true; }
  }

  let app = null;
  function startApp({ firstRun = false, keepSettings = true } = {}) {
    if (app?.running) app.exit();
    if (!keepSettings || !settings) settings = makeSettings(firstRun);
    app = new TrayAppModel({ clock, bt, shell, renderer: kit.renderer, P: kit.P, settings, autostart, log, emit, timerQuantumMs: config.timerQuantumMs });
    shell.app = app;
    app.start();
    return app;
  }

  seedRegistry(config.firstRun, config.overflow);
  settings = makeSettings(config.firstRun);
  startApp();
  clock.onFrame(() => shell.render());

  const advanceWhile = async (pred, timeoutMs, stepMs = 10) => {
    const end = clock.now + timeoutMs;
    while (!pred()) {
      if (clock.now >= end) return false;
      await clock.advance(Math.min(stepMs, end - clock.now));
    }
    return true;
  };

  const qt = {
    config, kit, clock, bt, shell, PROFILES, PHASES,
    get app() { return app; },
    get now() { return clock.now; },

    state() {
      return { t: clock.now, clock: shell.clockText().time, mode: clock.mode, profile: bt.profileName, app: app.snapshot(), shell: shell.snapshot(), bt: bt.snapshot() };
    },
    log(sinceT = 0) { return logLines.filter((l) => l.t >= sinceT).map((l) => l.line); },
    timeline(sinceT = 0) {
      return [
        ...timeline.filter((e) => e.t >= sinceT).map((e) => ({ src: 'app', ...e })),
        ...shell.events.filter((e) => e.t >= sinceT).map((e) => ({ src: 'shell', ...e })),
        ...bt.events.filter((e) => e.t >= sinceT).map((e) => ({ src: 'bt', ...e })),
      ].sort((a, b) => a.t - b.t);
    },

    // time
    setMode(mode, speed) { clock.setMode(mode, speed); },
    advance(ms) { return clock.advance(ms); },
    /** Advance (manual mode) until fn(state) is truthy; returns true, or false after timeoutMs of virtual time. */
    async waitFor(fn, timeoutMs = 30000, stepMs = 10) { return advanceWhile(() => !!fn(qt.state()), timeoutMs, stepMs); },

    // input (physical px). The CLI prefers real Playwright mouse events; these are equivalents.
    move(x, y) { shell.pointerMove(x, y); },
    down(x, y, button = 'left') { shell.pointerDown(x, y, button); },
    up(x, y, button = 'left') { shell.pointerUp(x, y, button); },
    key(k) { return shell.menuKey(k); },
    locate(what) { return shell.locate(what); },

    /** QuickTooth.exe command line, forwarded to the running tray like the real IPC message. */
    cli(arg) {
      const map = { '--toggle': IPC.Toggle, '--connect': IPC.Connect, '--disconnect': IPC.Disconnect, '--exit': IPC.Exit, '--show-menu': IPC.ShowMenu, '--close-menu': IPC.CloseMenu };
      if (!(arg in map)) throw new Error(`unsupported: ${arg}`);
      if (!app.running) return 'no tray instance running';
      app.onCommand(map[arg]);
      return 'forwarded';
    },

    // world
    profile(p) { bt.setProfile(p); return bt.profileName; },
    setTheme(theme) { shell.setTheme(theme); },
    async setScale(scale) {
      if (window.qtHostSetScale) await window.qtHostSetScale(scale);
      shell.setScale(scale);
    },
    restartExplorer() { shell.restartExplorer(); },
    setPromoted(v) { shell.setPromoted(v); },
    restartApp(opts = {}) {
      if (opts.firstRun) { seedRegistry(true, false); settings = makeSettings(true); autostart.enabled = false; }
      return startApp({ ...opts, keepSettings: !opts.firstRun }).snapshot();
    },
    exitApp() { app.exit(); },

    /** Change tunables live in the C# core (src/QuickTooth.Core/Tunables.cs); the app redraws its icons. */
    tune(overrides) { kit.tune(overrides); app.rebuildIcons(); return { ...kit.P }; },

    /**
     * Renders the pending animation as frames without the taskbar, at the real timer cadence by
     * default: { phase, durationMs, tracerOffset, light, size, stepMs, bg } → [{ t, png(dataURL) }].
     */
    frames({ phase = 'Connecting', durationMs = 1200, tracerOffset = 0, light = shell.o.theme === 'light', size = shell.iconSize(), stepMs = app.timers.effective(kit.P.AnimFrameMs), bg } = {}) {
      bg ??= light ? '#EEEEEE' : '#1C1C1C';
      const out = [];
      for (let t = 0; t <= durationMs + 1e-6; t += stepMs) {
        const img = compositeOver(kit.renderer.renderAnim(phase, t / 1000, tracerOffset + t / 1000, light, size), bg);
        const c = document.createElement('canvas'); c.width = size; c.height = size; c.getContext('2d').putImageData(img, 0, 0);
        out.push({ t: +t.toFixed(2), png: c.toDataURL() });
      }
      return out;
    },
  };

  window.qt = qt;
  if (config.panel) buildPanel(document.getElementById('panel'), qt);
  document.body.dataset.ready = '1';
  return qt;
}

window.qtReady = boot().catch((e) => {
  document.body.dataset.ready = 'error';
  document.getElementById('screen').textContent = 'Simulator failed to start: ' + (e?.stack ?? e);
  throw e;
});
