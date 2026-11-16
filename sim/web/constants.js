// The app's timing and animation constants, read from the C# source at load time so the simulator
// can't silently drift from the real app. Every value can be overridden (the "tunables") to try
// something before changing the C#. If a name can't be found in the source, the baked-in fallback
// is used and a warning is reported (see `warnings`), which usually means the C# was refactored
// and this table needs updating.

const SOURCES = {
  tray: 'src/QuickTooth/TrayApp.cs',
  icon: 'src/QuickTooth/IconRenderer.cs',
};

// name → [source, fallback]. Fallbacks match the C# at the time the simulator was written.
const EXPECTED = {
  // TrayApp.cs
  PendingTimeoutMs: ['tray', 20000],
  IdlePollMs: ['tray', 20000],
  PendingPollMs: ['tray', 500],
  ResendAfterMs: ['tray', 8000],
  LinkTeardownWaitMs: ['tray', 5000],
  BatteryCheckMs: ['tray', 60000],
  // IconRenderer.cs
  AnimFrameMs: ['icon', 83],
  SpringSeconds: ['icon', 0.2],
  LandSeconds: ['icon', 0.5],
  DisconnectSeconds: ['icon', 0.8],
  CancelSeconds: ['icon', 0.3],
  Travel: ['icon', 1.9],
  TracerPeriod: ['icon', 1.1],
  SpotRadius: ['icon', 3.0],
  Zoom: ['icon', 1.125],
};

// Values that live in code rather than in named constants; kept here with their source location.
export const CODE_VALUES = {
  DebounceMs: 200,          // TrayApp.WndProcImpl: SetTimer(TIMER_DEBOUNCE, 200)
  TeardownPollMs: 200,      // TrayApp.StartAction: await Task.Delay(200) while the old link closes
  TeardownLogAboveMs: 300,  // TrayApp.StartAction: logs the wait only if it exceeded 300 ms
  FirstBatteryMs: 2500,     // TrayApp.Apply: first battery reading soon after connecting
  PromoteRetryMs: 3000,     // TrayApp ctor / TryPromoteOnce
  PromoteMaxAttempts: 10,
  AddRetryMs: 2000,
  BleScanSeconds: 12,       // TrayApp.MaybeScanBattery: BleBatteryScanner.ScanAsync(model, 12 s)
  BatteryMaxAgeMin: 5,
  BatteryShowAgeMin: 15,
  MenuBatteryMaxAgeS: 60,   // TrayApp.ShowMenu: MaybeScanBattery(60 s)
  TooltipMaxChars: 127,
  OnDarkTaskbar: '#FFFFFF', // IconRenderer.OnDarkTaskbar
  OnLightTaskbar: '#1A1A1A',// IconRenderer.OnLightTaskbar
};

/** Parses `const int A = 1, B = 2;`, `const double X = 0.2;` and `double Zoom { get; set; } = 1.125;`. */
export function parseCsConstants(text) {
  const out = {};
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  for (const m of text.matchAll(/\bconst\s+(?:int|double|float|long)\s+([^;]+);/g)) {
    for (const part of m[1].split(',')) {
      const kv = part.match(/^\s*([A-Za-z_]\w*)\s*=\s*(-?[\d.]+)(?:[dDfFmM])?\s*$/);
      if (kv) out[kv[1]] = { value: Number(kv[2]), line: lineOf(m.index) };
    }
  }
  for (const m of text.matchAll(/\b(?:double|int)\s+([A-Za-z_]\w*)\s*\{\s*get;\s*set;\s*\}\s*=\s*(-?[\d.]+)\s*;/g)) {
    out[m[1]] = { value: Number(m[2]), line: lineOf(m.index) };
  }
  return out;
}

/**
 * Loads the constants. `fetchText(path)` returns the file's text (repo-relative path) or throws.
 * Returns { values, provenance, warnings }.
 */
export async function loadConstants(fetchText) {
  const parsed = {};
  const warnings = [];
  for (const [key, path] of Object.entries(SOURCES)) {
    try {
      parsed[key] = parseCsConstants(await fetchText(path));
    } catch (e) {
      parsed[key] = {};
      warnings.push(`could not read ${path} (${e.message}); using built-in values`);
    }
  }
  const values = {};
  const provenance = {};
  for (const [name, [src, fallback]] of Object.entries(EXPECTED)) {
    const hit = parsed[src][name];
    if (hit) {
      values[name] = hit.value;
      provenance[name] = `${SOURCES[src]}:${hit.line}`;
      if (hit.value !== fallback) provenance[name] += ` (changed from ${fallback} when the sim was written)`;
    } else {
      values[name] = fallback;
      provenance[name] = 'fallback (not found in source)';
      if (Object.keys(parsed[src]).length) warnings.push(`${name} not found in ${SOURCES[src]}; using ${fallback}`);
    }
  }
  return { values: { ...values, ...CODE_VALUES }, provenance, warnings };
}
