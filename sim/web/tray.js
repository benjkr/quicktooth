// Port of src/QuickTooth/TrayApp.cs (plus the bits of Settings.cs, Battery.cs and Autostart.cs it
// uses), running on the simulator's virtual clock against the mock Bluetooth stack and the mock
// shell. Method names, control flow, timer IDs and log lines follow the C# one-to-one, so the
// simulated quicktooth.log can be read side by side with a real one.
//
// Win32 timer quirk modelled here: USER timers tick on the 15.625 ms system timer, so SetTimer(83)
// fires every ~94.8 ms (measured on the dev PC with sim/reference/probe/timerprobe.cs) — the real
// animation runs at ~10.5 fps, not the nominal 12.

import { stateName } from './bluetooth.js';

const TIMER = { ANIM: 1, TIMEOUT: 2, POLL: 3, DEBOUNCE: 4, FASTPOLL: 5, ADD_RETRY: 6, PROMOTE: 7, RESEND: 8, BATTERY: 9 };
const TIMER_NAME = Object.fromEntries(Object.entries(TIMER).map(([k, v]) => [v, `TIMER_${k}`]));
export const CMD = { CONNECT: 1, DISCONNECT: 2, AUTOSTART: 3, EXIT: 4, DEVICE_BASE: 100 };
export const IPC = { Toggle: 1, Connect: 2, Disconnect: 3, Exit: 4, ShowMenu: 5, CloseMenu: 6 };
export const EXE_PATH = 'C:\\Users\\you\\AppData\\Local\\Programs\\QuickTooth\\QuickTooth.exe';

/** Win32 SetTimer/KillTimer on the virtual clock, with the system-timer rounding. */
export class Win32Timers {
  constructor(clock, { quantumMs = 15.625, slackMs = 1.06 } = {}) {
    this.clock = clock;
    this.quantumMs = quantumMs;
    this.slackMs = slackMs;
    this._timers = new Map();
  }

  /** The interval a USER timer actually ticks at. */
  effective(ms) {
    const q = this.quantumMs;
    return q > 0 ? Math.ceil(ms / q - 1e-9) * q + this.slackMs : ms;
  }

  set(id, ms, onTick) {
    this.kill(id);
    const interval = this.effective(Math.max(10, ms)); // USER_TIMER_MINIMUM
    const t = { interval, handle: null };
    const arm = () => { t.handle = this.clock.after(interval, () => { if (this._timers.get(id) !== t) return; arm(); onTick(id); }); };
    this._timers.set(id, t);
    arm();
  }

  kill(id) {
    const t = this._timers.get(id);
    if (t) { t.handle?.cancel(); this._timers.delete(id); }
  }

  killAll() { for (const id of [...this._timers.keys()]) this.kill(id); }

  active() { return [...this._timers.entries()].map(([id, t]) => ({ id, name: TIMER_NAME[id] ?? id, intervalMs: +t.interval.toFixed(2), dueInMs: +(t.handle.due - this.clock.now).toFixed(1) })); }
}

/** DeviceWorker: one serial queue; each job takes a little virtual time (it's a COM call on an MTA thread). */
class DeviceWorker {
  constructor(clock) { this.clock = clock; this._tail = Promise.resolve(); }
  run(fn, ms) {
    const p = this._tail.then(() => this.clock.delay(ms)).then(fn);
    this._tail = p.catch(() => {});
    return p;
  }
}

/** Settings.cs (in memory). */
export class SimSettings {
  constructor(init = {}) {
    this.targetContainerId = init.targetContainerId ?? null;
    this.targetMac = init.targetMac ?? null;
    this.targetName = init.targetName ?? null;
    this.trayPromotedOnce = init.trayPromotedOnce ?? false;
    this.saves = 0;
  }
  get hasTarget() { return !!this.targetContainerId || !!this.targetMac; }
  save() { this.saves++; }
  setTarget(d) { this.targetContainerId = d.containerId; this.targetMac = d.mac; this.targetName = d.name; }
  resolve(devices) {
    return devices.find((d) => this.targetContainerId && d.containerId === this.targetContainerId)
      ?? devices.find((d) => this.targetMac && d.mac?.toLowerCase() === this.targetMac.toLowerCase()) ?? null;
  }
  static defaultTarget(devices) {
    return devices.filter((d) => d.name.toLowerCase().includes('airpods')).sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0))[0] ?? null;
  }
  resolveOrDefault(devices, persist, log) {
    if (this.hasTarget) return this.resolve(devices);
    const pick = SimSettings.defaultTarget(devices);
    if (pick && persist) {
      this.setTarget(pick);
      this.save();
      log(`default target chosen: ${pick.name} ${pick.containerId} MAC ${pick.mac}`);
    }
    return pick;
  }
}

/** Battery.cs: BatteryReading.Text / Describe. */
function batteryBuds(b) { return b.left != null && b.right != null ? Math.min(b.left, b.right) : (b.left ?? b.right); }
export function batteryText(b) {
  const parts = [];
  const buds = batteryBuds(b);
  if (buds != null) parts.push(`${buds}%${b.budsCharging ? ' charging' : ''}`);
  if (b.case != null) parts.push(`case ${b.case}%${b.caseCharging ? ' charging' : ''}`);
  return parts.length ? parts.join(' · ') : null;
}
const describe = (b) => `buds ${batteryBuds(b) ?? '?'}% (L ${b.left ?? '?'}, R ${b.right ?? '?'}), case ${b.case ?? '?'}, rssi ${b.rssi ?? 0}, ${b.source}`;
const appleModelOf = (dev) => {
  for (const e of dev.endpoints) { const m = /_vid&0001004c_pid&([0-9a-f]{4})/i.exec(e.bthDeviceId); if (m) return parseInt(m[1], 16); }
  return null;
};
const hex8 = (hr) => (hr >>> 0).toString(16).toUpperCase().padStart(8, '0');

export class TrayAppModel {
  /**
   * @param {object} o
   * @param {import('./clock.js').SimClock} o.clock
   * @param {import('./bluetooth.js').MockBluetooth} o.bt
   * @param {object} o.shell   mock shell (taskbar.js): addIcon/modifyIcon/removeIcon/trackPopupMenu/endMenu/iconSize/lightTaskbar/cursorPos/iconRect/notifyIconSettings
   * @param {import('./icon.js').IconRenderer} o.renderer
   * @param {object} o.P       constants + tunables
   * @param {SimSettings} o.settings
   * @param {{enabled:boolean}} o.autostart
   * @param {(line:string)=>void} o.log
   * @param {(e:object)=>void} [o.emit] structured event sink (timeline)
   */
  constructor({ clock, bt, shell, renderer, P, settings, autostart, log, emit, timerQuantumMs = 15.625, timerSlackMs = 1.06 }) {
    Object.assign(this, { clock, bt, shell, renderer, P, settings, autostart });
    this._log = log;
    this._emit = emit ?? (() => {});
    this.timers = new Win32Timers(clock, { quantumMs: timerQuantumMs, slackMs: timerSlackMs });
    this.worker = new DeviceWorker(clock);

    this.devices = [];
    this.target = null;
    this.haveSnapshot = false;
    this.lastStateLog = null;
    this.pending = null;               // 'Connect' | 'Disconnect' | null
    this.pendingSeq = 0;
    this.pendingContainer = null;
    this.pendingWatch = clock.stopwatch();
    this.anim = null;                  // AnimPhase
    this.animClock = clock.stopwatch();
    this.tracerOffset = 0;
    this.refreshing = false;
    this.refreshAgain = false;
    this.battery = null;
    this.batteryContainer = null;
    this.batteryScanning = false;
    this.wasConnected = false;
    this.iconAdded = false;
    this.addAttempts = 0;
    this.promoteAttempts = 0;
    this.iconSize = 0;
    this.lightTaskbar = false;
    this.iconOn = null;
    this.iconOff = null;
    this.shownIcon = null;
    this.shownTip = '';
    this.menuDevices = [];
    this.running = false;
    this.frames = 0;
    this.exePath = EXE_PATH;
  }

  log(msg) { this._log(msg); }
  setTimer(id, ms) { this.timers.set(id, ms, (i) => this.onTimer(i)); }
  killTimer(id) { this.timers.kill(id); }

  // ------------------------------------------------------------------ lifetime (TrayApp ctor / MessageLoop)

  start() {
    this.running = true;
    this.log(`tray start: ${EXE_PATH}`);
    this.lightTaskbar = this.shell.lightTaskbar();
    this.rebuildIcons();
    this.addIcon();
    this._unsubscribe = this.bt.onEndpointChanged(() => { if (this.running) this.setTimer(TIMER.DEBOUNCE, this.P.DebounceMs); }); // WM_APP_DEVCHANGE
    this.worker.run(() => this.log('RegisterEndpointNotificationCallback hr=0x00000000'), 2);
    this.requestRefresh();
    this.setTimer(TIMER.POLL, this.P.IdlePollMs);
    this.setTimer(TIMER.BATTERY, this.P.BatteryCheckMs);
    if (!this.settings.trayPromotedOnce) this.setTimer(TIMER.PROMOTE, this.P.PromoteRetryMs);
  }

  /** WM_DESTROY: Exit from the menu, or QuickTooth.exe --exit. */
  exit() {
    if (!this.running) return;
    this.removeIcon();
    this.shell.endMenu();
    this.timers.killAll();
    this._unsubscribe?.();
    this.running = false;
    this.log('tray exit');
    this._emit({ type: 'exit' });
  }

  // ------------------------------------------------------------------ window messages

  /** WM_TRAY from the shell: 'select' (left click, NIN_SELECT), 'keyselect' (NIN_KEYSELECT), 'contextmenu' (WM_CONTEXTMENU at x,y). */
  onTrayMessage(ev, x, y) {
    if (!this.running) return;
    switch (ev) {
      case 'select': case 'keyselect': this.toggle(ev === 'select' ? 'click' : 'key'); break;
      case 'contextmenu': this.showMenu(x, y); break;
    }
  }

  /** The registered QuickTooth.Command.v1 message, as sent by QuickTooth.exe --toggle etc. */
  onCommand(cmd) {
    if (!this.running) return;
    switch (cmd) {
      case IPC.Toggle: this.toggle('cli'); break;
      case IPC.Connect: this.startAction('Connect', 'cli'); break;
      case IPC.Disconnect: this.startAction('Disconnect', 'cli'); break;
      case IPC.Exit: this.exit(); break;
      case IPC.ShowMenu: { const r = this.shell.iconRect(); if (r) this.showMenu(Math.trunc((r.left + r.right) / 2), r.top); break; }
      case IPC.CloseMenu: this.shell.endMenu(); break;
    }
  }

  onTimer(id) {
    if (!this.running) return;
    switch (id) {
      case TIMER.ANIM: this.advanceAnimation(); break;
      case TIMER.TIMEOUT:
        this.log(`${this.pending} timed out after ${Math.trunc(this.pendingWatch.elapsedMs)} ms; showing the real state`);
        this.endPending();
        this.requestRefresh();
        break;
      case TIMER.FASTPOLL:
      case TIMER.POLL:
        this.requestRefresh();
        if (id === TIMER.POLL) this.checkIconMetrics();
        break;
      case TIMER.DEBOUNCE: this.killTimer(TIMER.DEBOUNCE); this.requestRefresh(); break;
      case TIMER.ADD_RETRY: this.killTimer(TIMER.ADD_RETRY); this.addIcon(); break;
      case TIMER.PROMOTE: this.killTimer(TIMER.PROMOTE); this.tryPromoteOnce(); break;
      case TIMER.RESEND: this.killTimer(TIMER.RESEND); this.resendConnect(); break;
      case TIMER.BATTERY:
        this.setTimer(TIMER.BATTERY, this.P.BatteryCheckMs);
        this.maybeScanBattery(this.P.BatteryMaxAgeMin * 60000);
        break;
    }
  }

  /** WM_SETTINGCHANGE "ImmersiveColorSet": the taskbar theme flipped. */
  onSettingChange(area) {
    if (!this.running) return;
    if (area === 'ImmersiveColorSet') {
      const light = this.shell.lightTaskbar();
      if (light !== this.lightTaskbar) {
        this.log(`taskbar theme -> ${light ? 'light' : 'dark'}`);
        this.lightTaskbar = light;
        this.rebuildIcons();
      }
    } else {
      this.checkIconMetrics();
    }
  }

  /** WM_DISPLAYCHANGE / WM_DPICHANGED. */
  onDisplayChange() { if (this.running) this.checkIconMetrics(); }

  /** "TaskbarCreated": Explorer restarted. */
  onTaskbarCreated() {
    if (!this.running) return;
    this.log('TaskbarCreated: re-adding icon');
    this.iconAdded = false;
    this.addAttempts = 0;
    this.rebuildIcons();
    this.addIcon();
  }

  // ------------------------------------------------------------------ state

  requestRefresh() {
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshAsync();
  }

  async refreshAsync() {
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const mac = this.target?.mac;
        const ms = this.bt._ms('enumerateMs') + (mac ? this.bt._ms('pnpMs') : 0);
        const [snap, windowsBattery] = await this.worker.run(() => [this.bt.enumerate(), mac ? this.bt.windowsBattery(mac) : null], ms);
        if (!this.running) return;
        this.apply(snap, windowsBattery);
      } while (this.refreshAgain);
    } catch (e) {
      this.log(`ERROR refresh: ${e}`);
    } finally {
      this.refreshing = false;
    }
  }

  apply(snap, windowsBattery = null) {
    this.devices = snap;
    this.haveSnapshot = true;
    this.target = this.settings.resolveOrDefault(this.devices, true, (m) => this.log(m));

    const connected = this.target?.connected === true;
    if (!connected) {
      this.battery = null;
    } else {
      if (windowsBattery != null) {
        if (this.battery?.source !== 'windows' || this.battery.left !== windowsBattery) this.log(`battery: ${windowsBattery}% (Windows)`);
        this.battery = { left: windowsBattery, right: null, case: null, budsCharging: false, caseCharging: false, rssi: 0, at: this.clock.now, source: 'windows' };
        this.batteryContainer = this.target.containerId;
      }
      if (!this.wasConnected) this.setTimer(TIMER.BATTERY, this.P.FirstBatteryMs);
    }
    this.wasConnected = connected;

    const stateLog = this.target
      ? `${this.target.name}: ${this.target.connected ? 'connected' : 'not connected'} (${this.target.stateSignature})`
      : this.settings.hasTarget ? `${this.settings.targetName}: not available` : 'no target';
    if (stateLog !== this.lastStateLog) {
      this.log('state ' + stateLog);
      this.lastStateLog = stateLog;
    }

    if (this.pending && this.target && this.target.connected === (this.pending === 'Connect')) {
      this.log(`${this.pending} confirmed after ${Math.trunc(this.pendingWatch.elapsedMs)} ms`);
      this._emit({ type: 'confirmed', op: this.pending, ms: this.pendingWatch.elapsedMs });
      this.endPending(true);
    }
    this.updateIcon();
  }

  toggle(source) {
    if (this.pending) { this.log(`${source}: ignored, ${this.pending} still pending`); return; }
    if (!this.target) {
      this.log(`${source}: no target device`);
      if (source !== 'cli') { const p = this.shell.cursorPos(); if (p) this.showMenu(p.x, p.y); }
      return;
    }
    this.startAction(this.target.connected ? 'Disconnect' : 'Connect', source);
  }

  async startAction(op, source) {
    try {
      if (this.pending) { this.log(`${source}: ${op} ignored, ${this.pending} still pending`); return; }
      const target = this.target;
      if (!target) { this.log(`${source}: ${op} ignored, no target`); return; }
      if (target.connected === (op === 'Connect')) { this.log(`${source}: already ${target.connected ? 'connected' : 'disconnected'}`); return; }

      this.pending = op;
      const seq = ++this.pendingSeq;
      this.pendingContainer = target.containerId;
      this.pendingWatch.restart();
      this.startAnimation(op === 'Connect' ? 'Connecting' : 'Disconnecting');
      this.log(`${source}: ${op} '${target.name}' ${target.containerId} (was ${target.stateSignature})`);
      this._emit({ type: 'start', op, source });
      this.updateIcon();

      if (op === 'Connect' && target.mac) {
        // After a disconnect the Bluetooth link lingers ~3 s; wait (still animating) until it has closed.
        const hold = this.clock.stopwatch();
        while (hold.elapsedMs < this.P.LinkTeardownWaitMs
          && (await this.worker.run(() => this.bt.bluetoothConnected(target.mac), this.bt._ms('pnpMs'))) === true) {
          await this.clock.delay(this.timers.effective(this.P.TeardownPollMs) - this.timers.slackMs);
        }
        if (seq !== this.pendingSeq || this.pending !== op) return;
        if (hold.elapsedMs > this.P.TeardownLogAboveMs) this.log(`waited ${Math.trunc(hold.elapsedMs)} ms for the previous link to close`);
      }

      this.setTimer(TIMER.TIMEOUT, this.P.PendingTimeoutMs);
      this.setTimer(TIMER.FASTPOLL, this.P.PendingPollMs);
      if (op === 'Connect') this.setTimer(TIMER.RESEND, this.P.ResendAfterMs);

      const results = await this.worker.run(() => this.sendOneShot(target.containerId, op), this.bt._ms('sendMs'));
      if (results.length === 0 || results.every((r) => r.hr < 0)) {
        this.log(`${op}: no control accepted the request`);
        this.endPending();
      }
      this.requestRefresh();
    } catch (e) {
      this.log(`ERROR ${op}: ${e}`);
      this.endPending();
      this.requestRefresh();
    }
  }

  /** BluetoothAudio.SendOneShot, with its log lines. */
  sendOneShot(containerId, op) {
    const results = this.bt.sendOneShot(containerId, op);
    const prop = op === 'Connect' ? 'ONESHOT_RECONNECT' : 'ONESHOT_DISCONNECT';
    for (const r of results) this.log(`KsProperty ${prop} -> hr=0x${hex8(r.hr)} bytes=0  [${r.endpointName}]  ${r.bthDeviceId}`);
    if (results.length === 0) this.log(`KsProperty ${prop}: no Bluetooth KS controls found for container ${containerId}`);
    return results;
  }

  endPending(succeeded = false) {
    const op = this.pending;
    this.pending = null;
    this.pendingSeq++;
    const t = this.animClock.elapsedSeconds;
    if (op === 'Connect' && this.anim === 'Connecting') {
      this.startAnimation(succeeded ? 'Landing' : 'Cancelling', this.tracerOffset + t);
    } else if (op === 'Disconnect' && this.anim === 'Disconnecting' && succeeded) {
      /* keeps playing; advanceAnimation stops it at its end pose */
    } else {
      this.stopAnimation();
    }
    this.killTimer(TIMER.TIMEOUT);
    this.killTimer(TIMER.FASTPOLL);
    this.killTimer(TIMER.RESEND);
    this._emit({ type: 'end', op, succeeded });
    this.updateIcon();
  }

  async resendConnect() {
    if (this.pending !== 'Connect') return;
    const container = this.pendingContainer;
    this.log(`Connect not confirmed after ${Math.trunc(this.pendingWatch.elapsedMs)} ms; resending once`);
    this._emit({ type: 'resend' });
    try { await this.worker.run(() => this.sendOneShot(container, 'Connect'), this.bt._ms('sendMs')); }
    catch (e) { this.log(`ERROR resend: ${e}`); }
    this.requestRefresh();
  }

  // ------------------------------------------------------------------ notify icon text

  statusText() {
    if (this.pending === 'Connect') return 'Connecting…';
    if (this.pending === 'Disconnect') return 'Disconnecting…';
    if (!this.haveSnapshot) return 'Checking…';
    if (!this.target) return this.settings.hasTarget ? 'Not available' : 'No device selected';
    return this.target.connected ? 'Connected' : 'Not connected';
  }

  deviceLabel() { return this.target?.name ?? this.settings.targetName ?? 'QuickTooth'; }

  batteryText() {
    if (this.pending || this.target?.connected !== true || !this.battery) return null;
    if (this.batteryContainer !== this.target.containerId || this.clock.now - this.battery.at > this.P.BatteryShowAgeMin * 60000) return null;
    return batteryText(this.battery);
  }

  statusLine() {
    const b = this.batteryText();
    return b ? `${this.deviceLabel()} — ${this.statusText()} · ${b}` : `${this.deviceLabel()} — ${this.statusText()}`;
  }

  async maybeScanBattery(maxAgeMs) {
    const target = this.target;
    if (this.batteryScanning || this.pending || target?.connected !== true) return;
    if (this.battery && this.batteryContainer === target.containerId
      && (this.battery.source === 'windows' || this.clock.now - this.battery.at < maxAgeMs)) return;
    const model = appleModelOf(target);
    if (model == null) return;
    this.batteryScanning = true;
    try {
      const r = await this.bt.bleScan(model, this.P.BleScanSeconds * 1000);
      if (this.target?.containerId !== target.containerId || this.target.connected !== true) return;
      if (!r) { this.log('battery: no status advert heard'); return; }
      const reading = { ...r, at: this.clock.now };
      if (batteryText(this.battery ?? {}) !== batteryText(reading)) this.log('battery: ' + describe(reading));
      this.battery = reading;
      this.batteryContainer = target.containerId;
      this.updateIcon();
    } catch (e) {
      this.log(`ERROR battery scan: ${e}`);
    } finally {
      this.batteryScanning = false;
    }
  }

  // ------------------------------------------------------------------ pending animation

  startAnimation(phase, tracerOffset = 0) {
    this.anim = phase;
    this.tracerOffset = tracerOffset;
    this.animClock.restart();
    this.setTimer(TIMER.ANIM, this.P.AnimFrameMs);
    this._emit({ type: 'anim', phase });
    this.updateIcon();
  }

  stopAnimation() {
    this.anim = null;
    this.killTimer(TIMER.ANIM);
    this._emit({ type: 'anim', phase: null });
    this.updateIcon();
  }

  advanceAnimation() {
    const t = this.animClock.elapsedSeconds;
    const done = this.renderer.phaseDone(this.anim, t, this.pending === 'Disconnect');
    if (done) this.stopAnimation(); else this.updateIcon();
  }

  updateIcon(force = false) {
    let icon, desc, animFrame = false;
    if (this.anim && this.iconSize > 0) {
      const t = this.animClock.elapsedSeconds;
      icon = this.renderer.renderAnim(this.anim, t, this.tracerOffset + t, this.lightTaskbar, this.iconSize);
      desc = { kind: 'anim', phase: this.anim, t: +t.toFixed(4), tracerT: +(this.tracerOffset + t).toFixed(4) };
      animFrame = true;
      this.frames++;
    } else {
      const on = this.target?.connected === true;
      icon = on ? this.iconOn : this.iconOff;
      desc = { kind: 'static', state: on ? 'connected' : 'disconnected' };
    }
    let tip = this.statusLine();
    if (tip.length > this.P.TooltipMaxChars) tip = tip.slice(0, this.P.TooltipMaxChars);
    if (!force && !animFrame && icon === this.shownIcon && tip === this.shownTip) return;
    if (tip !== this.shownTip && !this.pending) this.log('tooltip: ' + tip);
    this.shownIcon = icon;
    this.shownTip = tip;
    this.shownDesc = desc;
    if (this.iconAdded) this.shell.modifyIcon(icon, tip, desc);
  }

  addIcon() {
    if (this.iconAdded) return;
    this.updateIcon();
    if (!this.shell.addIcon(this.shownIcon, this.shownTip, this.shownDesc)) {
      this.addAttempts++;
      this.log(`NIM_ADD failed (attempt ${this.addAttempts}); retrying`);
      if (this.addAttempts < 60) this.setTimer(TIMER.ADD_RETRY, this.P.AddRetryMs);
      return;
    }
    this.iconAdded = true;
    this.log(`tray icon added (${this.iconSize} px, ${this.lightTaskbar ? 'light' : 'dark'} taskbar)`);
  }

  removeIcon() {
    if (!this.iconAdded) return;
    this.shell.removeIcon();
    this.iconAdded = false;
  }

  checkIconMetrics() { if (this.shell.iconSize() !== this.iconSize) this.rebuildIcons(); }

  rebuildIcons() {
    const size = this.shell.iconSize();
    const rebuilt = this.iconOn != null;
    this.iconOn = this.renderer.renderStatic('connected', this.lightTaskbar, size);
    this.iconOff = this.renderer.renderStatic('disconnected', this.lightTaskbar, size);
    this.iconSize = size;
    if (rebuilt) this.log(`icons rebuilt: ${size} px, ${this.lightTaskbar ? 'light' : 'dark'} taskbar`);
    this.updateIcon(true);
  }

  // ------------------------------------------------------------------ menu

  /** Builds the popup menu exactly like TrayApp.ShowMenu, shows it (modal), then runs the command. */
  async showMenu(x, y) {
    this.maybeScanBattery(this.P.MenuBatteryMaxAgeS * 1000);
    const items = [];
    items.push({ id: 9, text: this.statusLine(), grayed: true });
    items.push({ separator: true });
    if (this.pending) items.push({ id: 0, text: this.statusText(), grayed: true });
    else if (!this.target) items.push({ id: 0, text: 'Connect', grayed: true });
    else if (this.target.connected) items.push({ id: CMD.DISCONNECT, text: 'Disconnect' });
    else items.push({ id: CMD.CONNECT, text: 'Connect' });

    const sub = [];
    this.menuDevices = this.devices.slice();
    this.menuDevices.forEach((d, i) => {
      const isTarget = this.target && d.containerId === this.target.containerId;
      sub.push({ id: CMD.DEVICE_BASE + i, text: d.name + (d.connected ? '  (connected)' : ''), checked: !!isTarget });
    });
    if (!this.target && this.settings.hasTarget) sub.push({ id: 0, text: `${this.settings.targetName ?? 'Saved device'} (not available)`, grayed: true, checked: true });
    if (this.menuDevices.length === 0 && !(!this.target && this.settings.hasTarget)) sub.push({ id: 0, text: 'No Bluetooth audio devices', grayed: true });
    items.push({ text: 'Device', grayed: !!this.pending, submenu: sub });

    items.push({ separator: true });
    items.push({ id: CMD.AUTOSTART, text: 'Start with Windows', checked: this.autostart.enabled });
    items.push({ id: CMD.EXIT, text: 'Exit' });

    this._emit({ type: 'menu', open: true });
    const cmd = await this.shell.trackPopupMenu(items, x, y, { light: this.lightTaskbar });
    this._emit({ type: 'menu', open: false, cmd });
    this.onMenuCommand(cmd);
  }

  onMenuCommand(cmd) {
    switch (cmd) {
      case 0: case null: case undefined: return;
      case CMD.CONNECT: this.startAction('Connect', 'menu'); return;
      case CMD.DISCONNECT: this.startAction('Disconnect', 'menu'); return;
      case CMD.AUTOSTART:
        if (this.autostart.enabled) { this.autostart.enabled = false; this.log('autostart off'); }
        else { this.autostart.enabled = true; this.log(`autostart on: "${EXE_PATH}"`); }
        return;
      case CMD.EXIT: this.exit(); return;
    }
    const index = cmd - CMD.DEVICE_BASE;
    if (index >= 0 && index < this.menuDevices.length && !this.pending) {
      const d = this.menuDevices[index];
      this.settings.setTarget(d);
      this.settings.save();
      this.log(`target set: ${d.name} ${d.containerId} MAC ${d.mac}`);
      this.target = d;
      this.updateIcon();
      this.requestRefresh();
    }
  }

  // ------------------------------------------------------------------ overflow promotion

  tryPromoteOnce() {
    this.promoteAttempts++;
    const result = this.shell.notifyIconSettings.promoteSelf(EXE_PATH, (m) => this.log(m));
    this.log(`tray promotion attempt ${this.promoteAttempts}: ${result}`);
    if (result === 'EntryNotFound' && this.promoteAttempts < this.P.PromoteMaxAttempts) {
      this.setTimer(TIMER.PROMOTE, this.P.PromoteRetryMs);
      return;
    }
    this.settings.trayPromotedOnce = true;
    this.settings.save();
  }

  // ------------------------------------------------------------------ introspection

  snapshot() {
    return {
      running: this.running,
      pending: this.pending,
      anim: this.anim,
      animT: this.anim ? +this.animClock.elapsedSeconds.toFixed(3) : null,
      target: this.target ? { name: this.target.name, connected: this.target.connected, stateSignature: this.target.stateSignature } : null,
      haveSnapshot: this.haveSnapshot,
      statusText: this.statusText(),
      tooltip: this.shownTip,
      icon: this.shownDesc,
      iconSize: this.iconSize,
      battery: this.battery ? { text: batteryText(this.battery), source: this.battery.source } : null,
      autostart: this.autostart.enabled,
      settings: { targetName: this.settings.targetName, trayPromotedOnce: this.settings.trayPromotedOnce },
      timers: this.timers.active(),
      animFrames: this.frames,
    };
  }
}

export { stateName };
