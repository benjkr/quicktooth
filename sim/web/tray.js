// The tray app in the simulator. Its behaviour is NOT reimplemented here: TrayAppModel runs the
// app's own C# TrayController (src/QuickTooth.Core, compiled to WebAssembly, see core.js) — the
// same code as QuickTooth.exe. This file is the simulator's stand-in for the Windows side
// (src/QuickTooth/TrayApp.cs + WindowsDevices.cs): Win32 timers on the virtual clock, the device
// worker, the mock shell and the mock Bluetooth stack.
//
// Win32 timer quirk modelled here: USER timers tick on the 15.625 ms system timer, so SetTimer(83)
// fires every ~94.8 ms (measured on the dev PC with sim/reference/probe/timerprobe.cs) — the real
// animation runs at ~10.5 fps, not the nominal 12.

import { stateName } from './bluetooth.js';
import { setLatestHost } from './core.js';

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

/** The settings file (Settings.cs), kept in the page. The C# loads it at start and saves through saveSettings(). */
export class SimSettings {
  constructor(init = {}) {
    this.targetContainerId = init.targetContainerId ?? null;
    this.targetMac = init.targetMac ?? null;
    this.targetName = init.targetName ?? null;
    this.trayPromotedOnce = init.trayPromotedOnce ?? false;
    this.saves = 0;
  }
  get hasTarget() { return !!this.targetContainerId || !!this.targetMac; }
  toJSON() { return { targetContainerId: this.targetContainerId, targetMac: this.targetMac, targetName: this.targetName, trayPromotedOnce: this.trayPromotedOnce }; }
  save() { this.saves++; }
}

/**
 * One QuickTooth tray process: the C# TrayController plus this page-side host for it. Same API the
 * simulator has always used (start, exit, onTrayMessage, onCommand, snapshot, timers, …).
 */
export class TrayAppModel {
  /**
   * @param {object} o
   * @param {import('./clock.js').SimClock} o.clock
   * @param {import('./bluetooth.js').MockBluetooth} o.bt
   * @param {object} o.shell   mock shell (shell.js)
   * @param {import('./icon.js').IconRenderer} o.renderer  carries the loaded C# core (renderer.core)
   * @param {object} o.P       the C# tunables (read-only here; change them with kit.tune)
   * @param {SimSettings} o.settings
   * @param {{enabled:boolean}} o.autostart
   * @param {(line:string)=>void} o.log
   * @param {(e:object)=>void} [o.emit] structured event sink (timeline)
   */
  constructor({ clock, bt, shell, renderer, P, settings, autostart, log, emit, timerQuantumMs = 15.625, timerSlackMs = 1.06 }) {
    Object.assign(this, { clock, bt, shell, renderer, P, settings, autostart });
    this.core = renderer.core;
    this._log = log;
    this._emit = emit ?? (() => {});
    this.timers = new Win32Timers(clock, { quantumMs: timerQuantumMs, slackMs: timerSlackMs });
    this.worker = new DeviceWorker(clock);
    this.exePath = EXE_PATH;
    this.id = 0;
    this._exited = false;
  }

  get running() { return this.id !== 0 && !this._exited && this.core.AppRunning(this.id); }

  // ------------------------------------------------------------------ lifetime and window messages

  start() {
    setLatestHost(this);
    this.id = this.core.AppCreate(this, JSON.stringify(this.settings));
    this._unsubscribe = this.bt.onEndpointChanged(() => { if (this.running) this.core.AppEndpointChanged(this.id); }); // WM_APP_DEVCHANGE
    this.core.AppStart(this.id);
  }

  /** WM_DESTROY: Exit from the menu, or QuickTooth.exe --exit. */
  exit() { if (this.running) this.core.AppExit(this.id); }

  /** WM_TRAY from the shell: 'select' (left click, NIN_SELECT), 'keyselect' (NIN_KEYSELECT), 'contextmenu' (WM_CONTEXTMENU at x,y). */
  onTrayMessage(ev, x = 0, y = 0) { if (this.running) this.core.AppTrayEvent(this.id, ev, Math.trunc(x), Math.trunc(y)); }

  /** The registered QuickTooth.Command.v1 message, as sent by QuickTooth.exe --toggle etc. */
  onCommand(cmd) { if (this.running) this.core.AppCommand(this.id, cmd); }

  /** WM_SETTINGCHANGE ("ImmersiveColorSet" = the taskbar theme flipped). */
  onSettingChange(area) { if (this.running) this.core.AppSettingChange(this.id, area ?? null); }

  /** WM_DISPLAYCHANGE / WM_DPICHANGED. */
  onDisplayChange() { if (this.running) this.core.AppDisplayChange(this.id); }

  /** "TaskbarCreated": Explorer restarted. */
  onTaskbarCreated() { if (this.running) this.core.AppTaskbarCreated(this.id); }

  /** Redraw the static icons (after kit.tune). */
  rebuildIcons() { if (this.running) this.core.AppRebuildIcons(this.id); }

  snapshot() {
    const s = JSON.parse(this.core.AppSnapshot(this.id));
    return { ...s, running: this.running, autostart: this.autostart.enabled, timers: this.timers.active() };
  }

  // ------------------------------------------------------------------ the host, called from C# (core.js "qt-host")

  log(line) { this._log(line); }
  nowMs() { return this.clock.now; }
  nowEpochMs() { return this.clock.now; }
  /** Task.Delay: Windows rounds it up to the 15.625 ms system timer like SetTimer. */
  delay(ms) { return this.clock.delay(this.timers.effective(ms) - this.timers.slackMs); }
  setTimer(id, ms) { this.timers.set(id, ms, (i) => { if (!this._exited) this.core.AppTimer(this.id, i); }); }
  killTimer(id) { this.timers.kill(id); }
  killAllTimers() { this.timers.killAll(); }

  lightTaskbar() { return this.shell.lightTaskbar(); }
  iconSize() { return this.shell.iconSize(); }
  _image(rgba, size) { return new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength).slice(), size, size); }
  /** The pixels last handed to the shell (what the taskbar should be showing). */
  addIcon(rgba, size, tip, desc) { this.shownIcon = this._image(rgba, size); return this.shell.addIcon(this.shownIcon, tip, JSON.parse(desc)); }
  modifyIcon(rgba, size, tip, desc) { this.shownIcon = this._image(rgba, size); return this.shell.modifyIcon(this.shownIcon, tip, JSON.parse(desc)); }
  removeIcon() { this.shell.removeIcon(); }
  cursorPos() { const p = this.shell.cursorPos(); return p ? `${Math.trunc(p.x)},${Math.trunc(p.y)}` : ''; }
  iconAnchor() { const r = this.shell.iconRect(); return r ? `${Math.trunc((r.left + r.right) / 2)},${Math.trunc(r.top)}` : ''; }
  async trackPopupMenu(itemsJson, x, y, light) { return (await this.shell.trackPopupMenu(JSON.parse(itemsJson), x, y, { light })) ?? 0; }
  endMenu() { this.shell.endMenu(); }
  promoteSelf() { return this.shell.notifyIconSettings.promoteSelf(EXE_PATH, (m) => this.log(m)); }

  autostartEnabled() { return this.autostart.enabled; }
  setAutostart(on) {
    this.autostart.enabled = on;
    this.log(on ? `autostart on: "${EXE_PATH}"` : 'autostart off'); // Autostart.Enable / Disable
  }

  exitApp() { this._exited = true; this._unsubscribe?.(); }
  emit(json) { this._emit(JSON.parse(json)); }

  saveSettings(json) {
    const o = JSON.parse(json);
    Object.assign(this.settings, {
      targetContainerId: o.targetContainerId ?? null, targetMac: o.targetMac ?? null,
      targetName: o.targetName ?? null, trayPromotedOnce: !!o.trayPromotedOnce,
    });
    this.settings.save();
  }

  // The device side (WindowsDevices.cs): each call is a job on the device worker.
  btRegister() { return this.worker.run(() => this.log('RegisterEndpointNotificationCallback hr=0x00000000'), 2); }
  btRefresh(mac) {
    const ms = this.bt._ms('enumerateMs') + (mac ? this.bt._ms('pnpMs') : 0);
    return this.worker.run(() => JSON.stringify({ devices: this.bt.enumerate(), windowsBattery: mac ? this.bt.windowsBattery(mac) : null }), ms);
  }
  btSend(containerId, op) { return this.worker.run(() => JSON.stringify(this.bt.sendOneShot(containerId, op)), this.bt._ms('sendMs')); }
  btConnected(mac) {
    return this.worker.run(() => { const r = this.bt.bluetoothConnected(mac); return r == null ? -1 : r ? 1 : 0; }, this.bt._ms('pnpMs'));
  }
  async btScan(model, windowMs) { return JSON.stringify((await this.bt.bleScan(model, windowMs)) ?? null); }
}

export { stateName };
