// Side panel for people driving the simulator by hand (qt-sim open). Agents use window.qt instead.
const TUNABLES = [
  ['AnimFrameMs', 20, 200, 1], ['SpringSeconds', 0.05, 1, 0.01], ['LandSeconds', 0.1, 2, 0.01], ['DisconnectSeconds', 0.1, 2, 0.01],
  ['CancelSeconds', 0.05, 1.5, 0.01], ['Travel', 0, 4, 0.05], ['TracerPeriod', 0.3, 3, 0.05], ['SpotRadius', 0.5, 6, 0.1], ['Zoom', 0.8, 1.3, 0.005],
];

export function buildPanel(root, qt) {
  const { bt, shell, kit } = qt;
  const defaults = { ...kit.P };
  root.innerHTML = `
    <h1>QuickTooth taskbar simulator</h1>
    <div class="note">Hover, click and right-click the AirPods icon. Everything below runs on the simulated clock.</div>
    <h2>Time</h2>
    <div class="row" id="p-time"></div>
    <div class="row"><span class="mono" id="p-now"></span></div>
    <h2>Bluetooth</h2>
    <div class="row"><label>Profile</label><select id="p-profile"></select></div>
    <div class="note" id="p-profile-note"></div>
    <div class="row" id="p-world"></div>
    <pre id="p-bt"></pre>
    <h2>Taskbar</h2>
    <div class="row" id="p-taskbar"></div>
    <h2>App</h2>
    <div class="row" id="p-app"></div>
    <div class="kv" id="p-state"></div>
    <h2>Tunables <span class="note">(from the C#; drag to try values)</span></h2>
    <div class="tune" id="p-tune"></div>
    <div class="row"><button id="p-tune-reset">Reset to C# values</button></div>
    <h2>Animation frames <span class="note">(at the real ~94.8 ms timer cadence)</span></h2>
    <div id="p-strips"></div>
    <h2>quicktooth.log</h2>
    <pre id="p-log"></pre>`;
  const $ = (id) => root.querySelector('#' + id);
  const btn = (parent, label, fn, title) => { const b = document.createElement('button'); b.textContent = label; if (title) b.title = title; b.onclick = fn; parent.appendChild(b); return b; };

  // time
  const speeds = [['Pause', 0], ['¼×', 0.25], ['½×', 0.5], ['1×', 1], ['4×', 4]];
  const speedBtns = speeds.map(([label, sp]) => btn($('p-time'), label, () => { qt.setMode('realtime', sp); sync(); }));
  btn($('p-time'), '+1 tick', async () => { qt.setMode('manual'); await qt.advance(qt.app.timers.effective(kit.P.AnimFrameMs)); sync(); }, 'one animation timer tick');
  btn($('p-time'), '+1 s', async () => { qt.setMode('manual'); await qt.advance(1000); sync(); });

  // bluetooth
  const sel = $('p-profile');
  for (const [name, p] of Object.entries(qt.PROFILES)) { const o = document.createElement('option'); o.value = name; o.textContent = name; sel.appendChild(o); }
  sel.value = bt.profileName;
  sel.onchange = () => { qt.profile(sel.value); sync(); };
  const dev = () => bt.devices[0].name;
  btn($('p-world'), 'Connect externally', () => bt.externalConnect(dev()), 'the AirPods connect on their own (e.g. taken out of the case)');
  btn($('p-world'), 'Drop link', () => bt.externalDisconnect(dev()), 'put in the case / taken over by a phone');
  btn($('p-world'), 'Out of range', () => bt.setInRange(dev(), !bt.devices[0].inRange));
  btn($('p-world'), 'Unpair / re-pair', () => bt.setPresent(dev(), !bt.devices[0].present));
  btn($('p-world'), 'Battery 20%', () => bt.setBattery(dev(), { left: 20, right: 30 }));

  // taskbar
  btn($('p-taskbar'), 'Light / dark', () => qt.setTheme(shell.o.theme === 'dark' ? 'light' : 'dark'));
  const scaleSel = document.createElement('select');
  for (const s of [1, 1.25, 1.5, 1.75, 2]) { const o = document.createElement('option'); o.value = s; o.textContent = `${s * 100}%`; scaleSel.appendChild(o); }
  scaleSel.value = String(shell.o.scale);
  scaleSel.onchange = () => qt.setScale(Number(scaleSel.value));
  $('p-taskbar').appendChild(scaleSel);
  btn($('p-taskbar'), 'Solid / acrylic', () => { shell.o.taskbarStyle = shell.o.taskbarStyle === 'solid' ? 'acrylic' : 'solid'; shell.layout(); });
  btn($('p-taskbar'), 'Icon ↔ overflow', () => { const inOverflow = shell.snapshot().iconInOverflow; shell.setPromoted(inOverflow); });
  btn($('p-taskbar'), 'Restart Explorer', () => qt.restartExplorer());

  // app
  btn($('p-app'), 'Toggle (CLI)', () => qt.cli('--toggle'));
  btn($('p-app'), 'Show menu (CLI)', () => qt.cli('--show-menu'));
  btn($('p-app'), 'Restart app', () => qt.restartApp());
  btn($('p-app'), 'First run', () => qt.restartApp({ firstRun: true }));

  // tunables
  const tune = $('p-tune');
  const inputs = {};
  for (const [name, min, max, step] of TUNABLES) {
    const l = document.createElement('label'); l.textContent = name; l.title = kit.provenance[name] ?? '';
    const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = kit.P[name];
    const v = document.createElement('span'); v.className = 'mono'; v.textContent = kit.P[name];
    r.oninput = () => { v.textContent = r.value; qt.tune({ [name]: Number(r.value) }); drawStrips(); };
    tune.append(l, r, v);
    inputs[name] = { r, v };
  }
  $('p-tune-reset').onclick = () => { const o = {}; for (const [n] of TUNABLES) { o[n] = defaults[n]; inputs[n].r.value = defaults[n]; inputs[n].v.textContent = defaults[n]; } qt.tune(o); drawStrips(); };

  function drawStrips() {
    const host = $('p-strips');
    host.innerHTML = '';
    for (const [phase, ms, off] of [['Connecting', 1500, 0], ['Landing', kit.P.LandSeconds * 1000 + 100, 1.4], ['Disconnecting', kit.P.DisconnectSeconds * 1000 + 400, 0], ['Cancelling', kit.P.CancelSeconds * 1000 + 100, 1.4]]) {
      const lab = document.createElement('div'); lab.className = 'note'; lab.textContent = phase; host.appendChild(lab);
      const strip = document.createElement('div'); strip.className = 'strip';
      for (const f of qt.frames({ phase, durationMs: ms, tracerOffset: off, size: 16 })) { const im = document.createElement('img'); im.src = f.png; im.title = `t=${f.t} ms`; strip.appendChild(im); }
      host.appendChild(strip);
    }
  }
  drawStrips();

  function sync() {
    const st = qt.state();
    speedBtns.forEach((b, i) => b.classList.toggle('on', qt.clock.mode === 'realtime' && qt.clock.speed === speeds[i][1]));
    $('p-now').textContent = `t = ${(st.t / 1000).toFixed(3)} s   ${qt.clock.mode}${qt.clock.mode === 'realtime' ? ` ×${qt.clock.speed}` : ''}`;
    $('p-profile-note').textContent = qt.PROFILES[bt.profileName]?.label ?? 'custom';
    $('p-bt').textContent = st.bt.map((d) => `${d.name.padEnd(15)} link ${d.link.padEnd(9)} A2DP ${d.a2dp.padEnd(9)} HFP ${d.hfp}${d.connecting ? '  (connecting)' : ''}${!d.inRange ? '  OUT OF RANGE' : ''}${!d.present ? '  NOT PRESENT' : ''}`).join('\n')
      + '\n\n' + bt.events.slice(-6).map((e) => `${(e.t / 1000).toFixed(3).padStart(8)}  ${e.text}`).join('\n');
    const a = st.app;
    $('p-state').innerHTML = [
      ['tooltip', a.tooltip], ['pending', a.pending ?? '—'], ['animation', a.anim ? `${a.anim} t=${a.animT}s` : '—'],
      ['icon', a.icon ? (a.icon.kind === 'anim' ? `frame (${a.icon.phase})` : a.icon.state) : '—'], ['icon size', `${a.iconSize} px`],
      ['battery', a.battery?.text ?? '—'], ['timers', a.timers.map((t) => t.name.replace('TIMER_', '')).join(' ') || '—'],
      ['in overflow', String(st.shell.iconInOverflow)],
    ].map(([k, v]) => `<div>${k}</div><div class="mono">${String(v).replace(/</g, '&lt;')}</div>`).join('');
    const logEl = $('p-log');
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
    logEl.textContent = qt.log().slice(-80).map((l) => l.slice(11)).join('\n');
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
  let last = 0;
  qt.clock.onFrame(() => { const n = performance.now(); if (n - last > 100) { last = n; sync(); } });
  sync();
}
