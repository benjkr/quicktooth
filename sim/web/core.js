// Loads QuickTooth's shared C# code (src/QuickTooth.Core, built for the browser by
// sim/lib/core-build.mjs into sim/web/core) — the same icon renderer and tray state machine the
// Windows app runs. The page supplies the platform through the "qt-host" imports below; each call
// carries the JS host object of the app instance that made it (see tray.js TrayAppModel).
import { dotnet } from './core/wwwroot/_framework/dotnet.js';

const PER_HOST = [
  'nowMs', 'nowEpochMs', 'delay', 'setTimer', 'killTimer', 'killAllTimers', 'lightTaskbar', 'iconSize',
  'addIcon', 'modifyIcon', 'removeIcon', 'cursorPos', 'iconAnchor', 'trackPopupMenu', 'endMenu', 'promoteSelf',
  'autostartEnabled', 'setAutostart', 'exitApp', 'emit', 'btRegister', 'btRefresh', 'btSend', 'btConnected', 'btScan',
];

// Log lines and settings saves come from static C# code, so they go to the most recently started app
// (all apps in a page share one log and one settings object anyway).
let latest = null;
export function setLatestHost(host) { latest = host; }

const imports = {
  ...Object.fromEntries(PER_HOST.map((name) => [name, (host, ...args) => host[name](...args)])),
  exePath: (host) => host.exePath, // a property: the mock shell reads app.exePath too
  log: (line) => (latest ? latest.log(line) : console.warn('[core log]', line)),
  saveSettings: (json) => latest?.saveSettings(json),
};

let loading = null;

/** The C# Bridge exports (QuickTooth.Web.Bridge), loaded once per page. */
export function loadCore() {
  loading ??= (async () => {
    const t0 = performance.now();
    const runtime = await dotnet.create();
    runtime.setModuleImports('qt-host', imports);
    const all = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
    const core = all.QuickTooth.Web.Bridge;
    core.Init();
    core.loadMs = performance.now() - t0;
    return core;
  })();
  return loading;
}
