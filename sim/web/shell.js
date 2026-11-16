// The mock Windows 11 shell: taskbar, notification area, tooltips, overflow flyout, popup menus,
// and the per-icon NotifyIconSettings registry. It talks to the app model through the same
// contract Explorer gives a Shell_NotifyIcon v4 client: NIN_SELECT on left-button up, WM_CONTEXTMENU
// on right-button up with the cursor position as anchor, "TaskbarCreated" after an Explorer
// restart, WM_SETTINGCHANGE on a theme flip, WM_DISPLAYCHANGE on a scale change.
//
// Geometry: physical pixels throughout (the app is PerMonitorV2). Numbers at 100 % come from
// UI Automation on the real taskbar (sim/reference/metrics.json); other scales are DIPs × scale,
// rounded per element like XAML layout rounding.

import { smallIconSize } from './icon.js';
import { EXE_PATH } from './tray.js';
import { layoutMenu, placeMainMenu, placeSubmenu, drawMenu, rowAt, nextRow } from './menu.js';

/** DIP sizes measured on the real taskbar at 100 % (UIA bounding rectangles, Nov 2026, build 26300). */
export const TASKBAR = {
  height: 48,
  startW: 45, taskViewW: 44, appW: 44,
  chevronW: 32, iconW: 32, inputW: 44, netW: 24, volW: 24, showDesktopW: 12,
  gapInputNet: 4, gapNetVol: 4, gapVolClock: 8, gapClockDesk: 4,
  clockPadX: 7,           // fitted: the clock is 70 DIP wide for "09:26" / "11/16/2026" (text 56 DIP in Chromium)
  iconInsetX: 8, iconInsetY: 16, // 16 px icon at (+8, +16) inside its 32×48 button
  hoverInsetY: 4, hoverRadius: 4, // hover pill 32×40 (from the 1.5× demo video)
  tipGap: 13, tipPadX: 9, tipPadTop: 6, tipPadBottom: 8, tipLine: 16, tipRadius: 4, tipMaxW: 320, // tooltip (from the demo video; extrapolated)
};

const THEME = {
  dark: {
    taskbar: '#1C1C1C', taskbarTopLine: 'rgba(255,255,255,0.08)', text: '#FFFFFF',
    hover: 'rgba(255,255,255,0.0605)', pressed: 'rgba(255,255,255,0.0419)',
    tipBg: '#2C2C2C', tipBorder: 'rgba(255,255,255,0.07)', tipText: '#FFFFFF',
    flyoutBg: '#2C2C2C', flyoutBorder: 'rgba(255,255,255,0.08)',
  },
  light: {
    taskbar: '#EEEEEE', taskbarTopLine: 'rgba(0,0,0,0.07)', text: '#1A1A1A',
    hover: 'rgba(0,0,0,0.0373)', pressed: 'rgba(0,0,0,0.0241)',
    tipBg: '#F9F9F9', tipBorder: 'rgba(0,0,0,0.0578)', tipText: '#1A1A1A',
    flyoutBg: '#F3F3F3', flyoutBorder: 'rgba(0,0,0,0.0578)',
  },
};

// Segoe Fluent Icons code points (neutral placeholders for the parts of the taskbar QuickTooth doesn't touch).
const GLYPH = { chevronUp: '\uE70E', ethernet: '\uE839', volume: '\uE995', start: '\uE80F', taskView: '\uE7C4', folder: '\uE8B7', globe: '\uE774', terminal: '\uE756', mail: '\uE715', shield: '\uEA18', cloud: '\uE753', gear: '\uE713' };
const ICON_FONT = '"Segoe Fluent Icons", "Segoe MDL2 Assets"';
const UI_FONT = '"Segoe UI Variable Text", "Segoe UI", sans-serif';

/** HKCU\Control Panel\NotifyIconSettings: Explorer's per-icon "show on taskbar" flags. */
class NotifyIconSettings {
  constructor(shell) { this.shell = shell; this.entries = []; }
  ensure(exe, promoted) {
    let e = this.entries.find((x) => x.exe === exe);
    if (!e) { e = { key: String(7000000000000000000n + BigInt(this.entries.length + 1) * 1234567n), exe, isPromoted: promoted }; this.entries.push(e); }
    return e;
  }
  /** TrayPromotion.PromoteSelf. Explorer reacts to IsPromoted right away (assumed). */
  promoteSelf(exe, log) {
    const e = this.entries.find((x) => x.exe === exe);
    if (!e || !e.created) return 'EntryNotFound';
    if (e.isPromoted === 1) return 'AlreadyPromoted';
    e.isPromoted = 1;
    log(`NotifyIconSettings\\${e.key}: IsPromoted=1 (${exe})`);
    this.shell._promotedChanged();
    return 'Promoted';
  }
}

export class Shell {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root  the "screen" element
   * @param {import('./clock.js').SimClock} o.clock
   * @param {object} o.opts  { scale, screen:{width,height}, theme, taskbarStyle, epochMs, tooltipDelayMs, … }
   */
  constructor({ root, clock, opts }) {
    this.root = root;
    this.clock = clock;
    this.o = {
      scale: 1, screen: { width: 1920, height: 1080 }, theme: 'dark', taskbarStyle: 'solid',
      epochMs: Date.UTC(2026, 10, 16, 9, 41, 0), // shown as local wall-clock 09:41
      tooltipDelayMs: 500, tooltipFadeMs: 150, hoverFadeMs: 83, menuFadeMs: 150, menuShowDelayMs: 400,
      flyoutGapDip: 12, explorerRestartMs: 1500, entryCreateMs: 1200,
      cursor: true, dwm: true,
      extraIcons: [
        { id: 'cloud', glyph: GLYPH.cloud, tip: 'Cloud sync — Up to date', promoted: false },
        { id: 'shield', glyph: GLYPH.shield, tip: 'Security — No actions needed', promoted: false },
        { id: 'gear', glyph: GLYPH.gear, tip: 'Settings helper', promoted: false },
      ],
      ...opts,
    };
    this.registry = new NotifyIconSettings(this);
    this.app = null;              // TrayAppModel (set by main.js)
    this.appIcon = null;          // { img, tip, desc } while added
    this.explorerUp = true;
    this.mouse = { x: -100, y: -100, inside: false };
    this.hover = null;            // hit target key
    this.pressed = null;          // { key, button }
    this.fades = new Map();       // key → { from, to, start }
    this.tip = { key: null, state: 'hidden', handle: null, shownAt: 0, suppressedFor: null };
    this.menu = null;             // { windows:[{lay,pos,hot,items,openAt}], resolve, subTimer }
    this.flyout = { open: false, openedAt: 0 };
    this.events = [];             // shell-side timeline: clicks, menu open/close, tooltip show/hide
    this._build();
    this._bindInput();
    this.layout();
  }

  /** HKCU\Control Panel\NotifyIconSettings, as TrayPromotion sees it. */
  get notifyIconSettings() { return this.registry; }
  get s() { return this.o.scale; }
  get dpr() { return this.s; }
  get T() { return THEME[this.o.theme]; }
  _r(dip) { return Math.round(dip * this.s); }
  _css(px) { return px / this.s; }
  _ev(type, data = {}) { this.events.push({ t: this.clock.now, type, ...data }); if (this.events.length > 4000) this.events.shift(); }

  // ------------------------------------------------------------------ DOM

  _build() {
    const R = this.root;
    R.innerHTML = '';
    R.classList.add('qt-screen');
    const el = (cls, parent = R, tag = 'div') => { const e = document.createElement(tag); e.className = cls; parent.appendChild(e); return e; };
    this.dom = {};
    this.dom.wallpaper = el('qt-wallpaper');
    this.dom.taskbar = el('qt-taskbar');
    this.dom.topline = el('qt-topline', this.dom.taskbar);
    this.dom.center = el('qt-center', this.dom.taskbar);
    this.dom.tray = el('qt-tray', this.dom.taskbar);
    // Full-screen canvases at physical resolution, anchored at (0,0): anything drawn into them maps
    // 1:1 to screen pixels at every scale. (A small canvas at a fractional CSS position — e.g.
    // 1637 px / 1.25 — gets resampled by Chromium, which would shift or blur the icon.)
    this.dom.pxTaskbar = el('qt-px qt-px-taskbar', R, 'canvas');
    this.dom.flyout = el('qt-flyout');
    this.dom.pxFlyout = el('qt-px qt-px-flyout', R, 'canvas');
    this.dom.tooltip = el('qt-tooltip');
    this.dom.pxMenus = el('qt-px qt-px-menus', R, 'canvas');
    this.dom.cursor = el('qt-cursor');
    this.dom.cursor.innerHTML = `<svg viewBox="0 0 12 19" width="100%" height="100%"><path d="M0.5 0.5 L0.5 16 L4.3 12.4 L6.8 18.2 L9 17.2 L6.6 11.5 L11.5 11.5 Z" fill="#000" stroke="#fff" stroke-width="1" stroke-linejoin="round"/></svg>`;
    this.dom.banner = el('qt-banner');
  }

  /** Physical-px layout of every hit target. Call after scale/screen/theme/icon-set changes. */
  layout() {
    const s = this.s, W = this.o.screen.width, H = this.o.screen.height, D = TASKBAR;
    const r = (v) => this._r(v);
    const tbH = r(D.height), tbTop = H - tbH;
    this.geom = { W, H, tbTop, tbH, items: [] };
    const items = this.geom.items;

    // Notification area, right to left.
    let x = W;
    const push = (key, w, extra = {}) => { const it = { key, left: x - w, right: x, top: tbTop, bottom: H, ...extra }; items.push(it); x -= w; return it; };
    push('showDesktop', r(D.showDesktopW), { tip: 'Show desktop' }); x -= r(D.gapClockDesk);
    const timeText = this.clockText();
    const clockW = r(Math.ceil(Math.max(this._measure(timeText.time, 12), this._measure(timeText.date, 12))) + 2 * D.clockPadX);
    push('clock', clockW, { tip: timeText.long, hover: 'pill' }); x -= r(D.gapVolClock);
    const vol = push('volume', r(D.volW), { glyph: GLYPH.volume, group: 'omni' }); x -= r(D.gapNetVol);
    const net = push('network', r(D.netW), { glyph: GLYPH.ethernet, group: 'omni' }); x -= r(D.gapInputNet);
    // Network + volume are one Quick Settings button: one hover pill over both (plus 4 DIP each side).
    this.geom.omni = { left: net.left - r(4), right: vol.right + r(4), split: vol.left };
    push('input', r(D.inputW), { label: 'ENG', tip: 'Input language: English (United States)\nKeyboard: US', hover: 'pill' });
    // Visible notification icons: QuickTooth (if promoted) then promoted extras.
    for (const ic of this.visibleIcons()) push(`icon:${ic.id}`, r(D.iconW), { icon: ic, hover: 'pill' });
    push('chevron', r(D.chevronW), { glyph: GLYPH.chevronUp, tip: 'Show hidden icons', hover: 'pill' });
    this.geom.trayLeft = x;

    // Centered apps (generic placeholders).
    const apps = [['start', r(D.startW), GLYPH.start, 'Start'], ['taskview', r(D.taskViewW), GLYPH.taskView, 'Task View'], ['app1', r(D.appW), GLYPH.folder, 'Files'], ['app2', r(D.appW), GLYPH.globe, 'Browser'], ['app3', r(D.appW), GLYPH.terminal, 'Terminal']];
    const total = apps.reduce((a, b) => a + b[1], 0);
    let cx = Math.round((W - total) / 2);
    for (const [key, w, glyph, tip] of apps) { items.push({ key, left: cx, right: cx + w, top: tbTop, bottom: H, glyph, tip, hover: 'pill', center: true }); cx += w; }

    // Overflow flyout (extrapolated geometry).
    const hidden = this.hiddenIcons();
    const chev = items.find((i) => i.key === 'chevron');
    const cell = r(40), pad = r(4), cols = Math.max(1, Math.min(5, Math.ceil(Math.sqrt(Math.max(1, hidden.length)))));
    const rows = Math.max(1, Math.ceil(hidden.length / cols));
    const fw = cols * cell + 2 * pad, fh = rows * cell + 2 * pad;
    const fl = Math.min(W - r(8) - fw, Math.round((chev.left + chev.right) / 2 - fw / 2));
    const ft = tbTop - r(this.o.flyoutGapDip) - fh;
    this.geom.flyout = { left: fl, top: ft, right: fl + fw, bottom: ft + fh, cells: hidden.map((ic, i) => ({ key: `ficon:${ic.id}`, icon: ic, left: fl + pad + (i % cols) * cell, top: ft + pad + Math.floor(i / cols) * cell, right: fl + pad + (i % cols + 1) * cell, bottom: ft + pad + (Math.floor(i / cols) + 1) * cell, tip: ic.tip, hover: 'cell' })) };

    this._applyStatic();
    this.render();
  }

  _measure(text, px, font = UI_FONT) {
    this._mctx ??= new OffscreenCanvas(8, 8).getContext('2d');
    this._mctx.font = `${px}px ${font}`;
    return this._mctx.measureText(text).width;
  }

  /** The QuickTooth icon plus the extra demo icons, with their promoted flag. */
  allIcons() {
    const list = [];
    if (this.appIcon) {
      const entry = this.registry.entries.find((e) => e.exe === this.appIcon.exe);
      list.push({ id: 'quicktooth', app: true, promoted: entry?.isPromoted === 1, tip: this.appIcon.tip });
    }
    for (const e of this.o.extraIcons) list.push({ ...e, app: false });
    return list;
  }
  visibleIcons() { return this.allIcons().filter((i) => i.promoted).sort((a, b) => (a.app ? 1 : 0) - (b.app ? 1 : 0)); }
  hiddenIcons() { return this.allIcons().filter((i) => !i.promoted); }

  clockText() {
    const d = new Date(this.o.epochMs + this.clock.now);
    const p2 = (n) => String(n).padStart(2, '0');
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return {
      time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
      date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`,
      long: `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
    };
  }

  /** Builds the element tree for the current layout (positions in CSS px from physical px). */
  _applyStatic() {
    const { W, H, tbTop, tbH } = this.geom, T = this.T, css = (v) => `${this._css(v)}px`;
    const R = this.root.style;
    R.width = css(W); R.height = css(H);
    const tb = this.dom.taskbar.style;
    tb.left = '0px'; tb.top = css(tbTop); tb.width = css(W); tb.height = css(tbH);
    tb.display = this.explorerUp ? '' : 'none';
    tb.background = this.o.taskbarStyle === 'acrylic' ? (this.o.theme === 'dark' ? 'rgba(28,28,28,0.82)' : 'rgba(238,238,238,0.82)') : T.taskbar;
    tb.backdropFilter = this.o.taskbarStyle === 'acrylic' ? `blur(${this._css(this._r(30))}px) saturate(1.25)` : 'none';
    this.dom.topline.style.background = T.taskbarTopLine;
    this.dom.topline.style.height = css(Math.max(1, Math.round(this.s)));
    this.root.dataset.theme = this.o.theme;

    // The layers' CSS size is a multiple of 4 px: at every Windows scale (5/4, 3/2, 7/4, 2) that is a
    // whole number of physical pixels, so canvas pixel (x, y) is exactly screen pixel (x, y). (W / s
    // itself — e.g. 1920 / 1.75 — isn't representable and would make Chromium resample the layer.)
    const cssW = Math.ceil(W / this.s / 4) * 4, cssH = Math.ceil(H / this.s / 4) * 4;
    for (const c of [this.dom.pxTaskbar, this.dom.pxFlyout, this.dom.pxMenus]) {
      const pw = Math.round(cssW * this.s), ph = Math.round(cssH * this.s);
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; c._slot = null; }
      c.style.width = `${cssW}px`; c.style.height = `${cssH}px`;
    }
    this.dom.tray.innerHTML = '';
    this.dom.center.innerHTML = '';
    this._els = new Map();
    for (const it of this.geom.items) {
      const b = document.createElement('div');
      b.className = 'qt-btn';
      const st = b.style;
      st.left = css(it.left); st.top = css(it.top - tbTop); st.width = css(it.right - it.left); st.height = css(it.bottom - it.top);
      const bg = document.createElement('div'); bg.className = 'qt-btn-bg'; b.appendChild(bg);
      if (it.icon?.app) {
        // drawn into the taskbar pixel layer (see _paintAppIcon)
      } else if (it.icon) {
        const g = document.createElement('div'); g.className = 'qt-glyph'; g.textContent = it.icon.glyph; b.appendChild(g);
      } else if (it.glyph) {
        const g = document.createElement('div'); g.className = 'qt-glyph'; g.textContent = it.glyph; b.appendChild(g);
        if (it.key === 'start') g.classList.add('qt-start');
      } else if (it.label) {
        const g = document.createElement('div'); g.className = 'qt-label'; g.textContent = it.label; b.appendChild(g);
      } else if (it.key === 'clock') {
        const g = document.createElement('div'); g.className = 'qt-clock'; b.appendChild(g); this._clockEl = g;
      }
      (it.center ? this.dom.center : this.dom.tray).appendChild(b);
      this._els.set(it.key, { el: b, bg, it });
    }
    // Flyout cells.
    this.dom.flyout.innerHTML = '';
    const F = this.geom.flyout;
    Object.assign(this.dom.flyout.style, { left: css(F.left), top: css(F.top), width: css(F.right - F.left), height: css(F.bottom - F.top), background: T.flyoutBg, borderColor: T.flyoutBorder, borderRadius: css(this._r(8)) });
    for (const c of F.cells) {
      const b = document.createElement('div'); b.className = 'qt-btn';
      Object.assign(b.style, { left: css(c.left - F.left), top: css(c.top - F.top), width: css(c.right - c.left), height: css(c.bottom - c.top) });
      const bg = document.createElement('div'); bg.className = 'qt-btn-bg'; b.appendChild(bg);
      if (!c.icon.app) { const g = document.createElement('div'); g.className = 'qt-glyph'; g.textContent = c.icon.glyph; b.appendChild(g); }
      this.dom.flyout.appendChild(b);
      this._els.set(c.key, { el: b, bg, it: c });
    }
    this._paintAppIcon(true);
  }

  // ------------------------------------------------------------------ Shell_NotifyIcon (called by the app)

  lightTaskbar() { return this.o.theme === 'light'; }
  iconSize() { return smallIconSize(this.s); }

  addIcon(img, tip, desc) {
    if (!this.explorerUp) return false;
    const exe = this.app?.exePath ?? EXE_PATH;
    const first = !this.registry.entries.some((e) => e.exe === exe);
    this.appIcon = { img, tip, desc, exe };
    const entry = this.registry.ensure(exe, first ? 0 : undefined);
    // Explorer writes the NotifyIconSettings entry a moment after the first NIM_ADD.
    if (!entry.created) this.clock.after(this.o.entryCreateMs, () => { entry.created = true; });
    this._ev('nim_add', { promoted: entry.isPromoted === 1 });
    this.layout();
    return true;
  }

  modifyIcon(img, tip, desc) {
    if (!this.appIcon || !this.explorerUp) return false;
    const tipChanged = tip !== this.appIcon.tip;
    Object.assign(this.appIcon, { img, tip, desc });
    if (tipChanged) this._ev('tip', { tip });
    this._paintAppIcon();
    if (tipChanged && this.tip.state !== 'hidden' && this.tip.key?.endsWith('quicktooth')) this._renderTooltip();
    return true;
  }

  removeIcon() { this.appIcon = null; this._ev('nim_delete'); this.layout(); }

  cursorPos() { return { x: Math.round(this.mouse.x), y: Math.round(this.mouse.y) }; }

  /** Shell_NotifyIconGetRect. For an icon in the closed overflow, the chevron's rect (assumed). */
  iconRect() {
    const g = this.geom.items.find((i) => i.key === 'icon:quicktooth')
      ?? (this.flyout.open ? this.geom.flyout.cells.find((c) => c.key === 'ficon:quicktooth') : null)
      ?? this.geom.items.find((i) => i.key === 'chevron');
    return g ? { left: g.left, top: g.top, right: g.right, bottom: g.bottom } : null;
  }

  _promotedChanged() { this._ev('promoted'); this.layout(); }

  /** Where the app's icon image sits (physical px): centred in its button on whole pixels. */
  iconSlot(where = 'taskbar') {
    const g = where === 'taskbar' ? this.geom.items.find((i) => i.key === 'icon:quicktooth') : this.geom.flyout.cells.find((c) => c.key === 'ficon:quicktooth');
    if (!g) return null;
    const size = this.iconSize();
    // 16 px icon at (+8, +16) in its 32×48 button at 100 % (UIA), i.e. centred.
    return { x: g.left + Math.floor((g.right - g.left - size) / 2), y: g.top + Math.floor((g.bottom - g.top - size) / 2), size };
  }

  _paintAppIcon() {
    const icon = this.appIcon;
    for (const [canvas, where] of [[this.dom.pxTaskbar, 'taskbar'], [this.dom.pxFlyout, 'flyout']]) {
      const ctx = canvas.getContext('2d');
      const prev = canvas._slot;
      if (prev) ctx.clearRect(prev.x, prev.y, prev.size, prev.size);
      canvas._slot = null;
      const slot = icon?.img && this.explorerUp ? this.iconSlot(where) : null;
      if (!slot) continue;
      const img = icon.img;
      if (img.width === slot.size) ctx.putImageData(img, slot.x, slot.y);
      else {
        // The shell scales an icon of the wrong size into the slot (e.g. right after a DPI change).
        const tmp = new OffscreenCanvas(img.width, img.height); tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tmp, slot.x, slot.y, slot.size, slot.size);
      }
      canvas._slot = slot;
    }
  }

  // ------------------------------------------------------------------ menus (TrackPopupMenuEx)

  trackPopupMenu(items, x, y, { light } = {}) {
    if (this.menu) this._closeMenus(0);
    this._hideTooltip();
    return new Promise((resolve) => {
      const lay = layoutMenu(items, this.s);
      const pos = placeMainMenu(lay, x, y, { width: this.geom.W, height: this.geom.H });
      this.menu = { theme: light ? 'light' : 'dark', windows: [{ lay, pos, hot: -1, openAt: this.clock.now, parentRow: -1 }], resolve, timer: null, anchor: { x, y } };
      this._ev('menu_open', { x, y, rect: [pos.left, pos.top, pos.left + lay.width, pos.top + lay.height], items: items.map((i) => (i.separator ? '—' : i.text)) });
      this._renderMenus();
    });
  }

  endMenu() { if (this.menu) this._closeMenus(0); }

  _closeMenus(cmd) {
    const m = this.menu;
    if (!m) return;
    m.timer?.cancel();
    this.menu = null;
    this._ev('menu_close', { cmd });
    this._renderMenus();
    // The taskbar sees the mouse again: hover follows the cursor (no tooltip until it moves on).
    this._updateHover(this.mouse.x, this.mouse.y, { suppressTip: true });
    // Like TrackPopupMenuEx(TPM_RETURNCMD) returning: the app continues after the menu loop.
    m.resolve(cmd);
  }

  _openSubmenu(level, rowIndex) {
    const m = this.menu;
    const w = m.windows[level];
    const row = w.lay.rows[rowIndex];
    if (!row?.submenu || row.grayed) return;
    m.windows.length = level + 1;
    const lay = layoutMenu(row.submenu, this.s);
    const pos = placeSubmenu(lay, w.pos, w.lay, row, { width: this.geom.W, height: this.geom.H }, this.s);
    m.windows.push({ lay, pos, hot: -1, openAt: this.clock.now, parentRow: rowIndex });
    this._ev('submenu_open', { rect: [pos.left, pos.top, pos.left + lay.width, pos.top + lay.height] });
    this._renderMenus();
  }

  _menuWindowAt(x, y) {
    const m = this.menu; if (!m) return -1;
    for (let i = m.windows.length - 1; i >= 0; i--) {
      const { lay, pos } = m.windows[i];
      if (x >= pos.left && x < pos.left + lay.width && y >= pos.top && y < pos.top + lay.height) return i;
    }
    return -1;
  }

  _menuHover(x, y) {
    const m = this.menu;
    const level = this._menuWindowAt(x, y);
    if (level < 0) return;
    const w = m.windows[level];
    const row = rowAt(w.lay, y - w.pos.top);
    const idx = row >= 0 && !w.lay.rows[row].separator ? row : -1;
    if (idx === w.hot) return;
    w.hot = idx;
    // Hovering in a parent window: the child keeps showing until MenuShowDelay passes.
    m.timer?.cancel();
    const hasChild = m.windows.length > level + 1;
    const r = idx >= 0 ? w.lay.rows[idx] : null;
    if (r?.submenu && !r.grayed && !(hasChild && m.windows[level + 1].parentRow === idx)) {
      m.timer = this.clock.after(this.o.menuShowDelayMs, () => { if (this.menu === m) this._openSubmenu(level, idx); });
    } else if (hasChild && m.windows[level + 1].parentRow !== idx) {
      m.timer = this.clock.after(this.o.menuShowDelayMs, () => { if (this.menu === m) { m.windows.length = level + 1; this._renderMenus(); } });
    }
    this._renderMenus();
  }

  _menuClick(x, y) {
    const m = this.menu;
    const level = this._menuWindowAt(x, y);
    if (level < 0) { this._closeMenus(0); return; }
    const w = m.windows[level];
    const idx = rowAt(w.lay, y - w.pos.top);
    const row = w.lay.rows[idx];
    if (!row || row.separator || row.grayed) return;
    if (row.submenu) { m.timer?.cancel(); this._openSubmenu(level, idx); return; }
    this._closeMenus(row.id ?? 0);
  }

  menuKey(key) {
    const m = this.menu; if (!m) return false;
    const level = m.windows.length - 1, w = m.windows[level];
    switch (key) {
      case 'ArrowDown': w.hot = nextRow(w.lay, w.hot, 1); break;
      case 'ArrowUp': w.hot = nextRow(w.lay, w.hot, -1); break;
      case 'ArrowRight': if (w.hot >= 0 && w.lay.rows[w.hot].submenu) { this._openSubmenu(level, w.hot); m.windows[level + 1] && (m.windows[level + 1].hot = nextRow(m.windows[level + 1].lay, -1, 1)); } break;
      case 'ArrowLeft': if (level > 0) m.windows.length = level; break;
      case 'Escape': if (level > 0) m.windows.length = level; else this._closeMenus(0); break;
      case 'Enter': case ' ': {
        const row = w.lay.rows[w.hot];
        if (!row || row.grayed) break;
        if (row.submenu) { this._openSubmenu(level, w.hot); m.windows[level + 1].hot = nextRow(m.windows[level + 1].lay, -1, 1); }
        else this._closeMenus(row.id ?? 0);
        break;
      }
      default: return false;
    }
    this._renderMenus();
    return true;
  }

  _renderMenus() {
    const m = this.menu;
    if (m) for (const w of m.windows) {
      // Each menu window is drawn once per state into its own offscreen canvas…
      const key = `${m.theme}|${w.hot}|${w.lay.width}x${w.lay.height}`;
      if (w._key !== key) {
        w._canvas ??= new OffscreenCanvas(w.lay.width, w.lay.height);
        drawMenu(w._canvas.getContext('2d'), w.lay, { theme: m.theme, hot: w.hot });
        w._key = key;
      }
    }
    this._composeMenus();
  }

  /** …and composited into the full-screen menu layer with the fade-in and the DWM corners and shadow. */
  _composeMenus() {
    const c = this.dom.pxMenus, ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    const m = this.menu;
    if (!m) { this._menuFading = false; return; }
    let fading = false;
    for (const w of m.windows) {
      const k = this.o.menuFadeMs > 0 ? Math.min(1, (this.clock.now - w.openAt) / this.o.menuFadeMs) : 1;
      if (k < 1) fading = true;
      const { left: x, top: y } = w.pos, { width: W, height: H } = w.lay;
      ctx.save();
      ctx.globalAlpha = k;
      if (this.o.dwm) {
        // Windows 11 DWM: small rounded corners and a soft shadow on popup menus (not in WM_PRINT; extrapolated).
        const r = 4 * this.s;
        ctx.save();
        ctx.shadowColor = `rgba(0,0,0,${m.theme === 'dark' ? 0.36 : 0.18})`;
        ctx.shadowBlur = 12 * this.s; ctx.shadowOffsetY = 4 * this.s;
        ctx.beginPath(); ctx.roundRect(x, y, W, H, r); ctx.fillStyle = '#000'; ctx.fill();
        ctx.restore();
        ctx.beginPath(); ctx.roundRect(x, y, W, H, r); ctx.clip();
      }
      ctx.drawImage(w._canvas, x, y);
      ctx.restore();
    }
    this._menuFading = fading;
  }

  // ------------------------------------------------------------------ input

  _bindInput() {
    const R = this.root;
    const pos = (e) => { const b = R.getBoundingClientRect(); return { x: (e.clientX - b.left) * this.s, y: (e.clientY - b.top) * this.s }; };
    R.addEventListener('pointermove', (e) => { const p = pos(e); this.pointerMove(p.x, p.y); });
    R.addEventListener('pointerdown', (e) => { const p = pos(e); this.pointerDown(p.x, p.y, e.button === 2 ? 'right' : 'left'); e.preventDefault(); });
    R.addEventListener('pointerup', (e) => { const p = pos(e); this.pointerUp(p.x, p.y, e.button === 2 ? 'right' : 'left'); });
    R.addEventListener('pointerleave', () => { this.mouse.inside = false; this.pointerMove(-100, -100); });
    R.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => { if (this.menuKey(e.key)) e.preventDefault(); });
  }

  hitTest(x, y) {
    if (this.flyout.open) {
      const F = this.geom.flyout;
      if (x >= F.left && x < F.right && y >= F.top && y < F.bottom) return F.cells.find((c) => x >= c.left && x < c.right && y >= c.top && y < c.bottom) ?? { key: 'flyout' };
    }
    if (!this.explorerUp) return null;
    return this.geom.items.find((i) => x >= i.left && x < i.right && y >= i.top && y < i.bottom) ?? null;
  }

  _fade(key, to) {
    const cur = this._fadeLevel(key);
    const f = this.fades.get(key);
    if (f && f.to === to) return;
    this.fades.set(key, { from: cur, to, start: this.clock.now });
  }

  _fadeLevel(key) {
    const f = this.fades.get(key); if (!f) return 0;
    const k = this.o.hoverFadeMs > 0 ? Math.min(1, (this.clock.now - f.start) / this.o.hoverFadeMs) : 1;
    return f.from + (f.to - f.from) * k;
  }

  pointerMove(x, y) {
    this.mouse.x = x; this.mouse.y = y; this.mouse.inside = x >= 0 && y >= 0;
    if (this.menu) { this._menuHover(x, y); this.render(); return; } // the menu loop has capture
    this._updateHover(x, y);
    this.render();
  }

  _updateHover(x, y, { suppressTip = false } = {}) {
    const hit = this.hitTest(x, y);
    const key = hit?.key ?? null;
    if (key !== this.hover) {
      if (this.hover) this._fade(this.hover, 0);
      this.hover = key;
      if (key) this._fade(key, 1);
      if (suppressTip && key) this.tip.suppressedFor = key;
      this._tooltipTarget(hit);
    }
  }

  pointerDown(x, y, button) {
    this.mouse.x = x; this.mouse.y = y;
    if (this.menu) { if (this._menuWindowAt(x, y) < 0) { this._ev('click_dismiss_menu', { x, y }); this._closeMenus(0); this.pressed = { key: '__eaten__', button }; } return; }
    const hit = this.hitTest(x, y);
    if (this.flyout.open && !hit?.key?.startsWith('ficon:') && hit?.key !== 'flyout' && hit?.key !== 'chevron') { this.flyout.open = false; this._ev('flyout_close'); }
    this.pressed = hit ? { key: hit.key, button } : null;
    this._hideTooltip(true);
    this.render();
  }

  pointerUp(x, y, button) {
    this.mouse.x = x; this.mouse.y = y;
    const p = this.pressed;
    this.pressed = null;
    if (this.menu) {
      // A release over an item picks it (TPM_RIGHTBUTTON: either button). A release elsewhere does nothing.
      if (p?.key !== '__eaten__' && this._menuWindowAt(x, y) >= 0) this._menuClick(x, y);
      this.render();
      return;
    }
    if (!p || p.key === '__eaten__') { this.render(); return; }
    const hit = this.hitTest(x, y);
    if (hit?.key !== p.key) { this.render(); return; }
    this._ev(button === 'right' ? 'rclick' : 'click', { key: hit.key, x: Math.round(x), y: Math.round(y) });
    if (hit.key === 'chevron' && button === 'left') {
      this.flyout.open = !this.flyout.open; this.flyout.openedAt = this.clock.now; this._ev(this.flyout.open ? 'flyout_open' : 'flyout_close');
    } else if ((hit.key === 'icon:quicktooth' || hit.key === 'ficon:quicktooth') && this.app) {
      // Shell_NotifyIcon v4: NIN_SELECT on left-button up; WM_CONTEXTMENU (anchor = cursor) on right-button up.
      if (button === 'left') this.app.onTrayMessage('select');
      else this.app.onTrayMessage('contextmenu', Math.round(x), Math.round(y));
    }
    this.render();
  }

  // ------------------------------------------------------------------ tooltip

  _tooltipTarget(hit) {
    this.tip.handle?.cancel();
    this.tip.handle = null;
    if (this.tip.state !== 'hidden') this._hideTooltip();
    if (this.tip.suppressedFor && this.tip.suppressedFor !== hit?.key) this.tip.suppressedFor = null;
    const text = this._tipText(hit);
    if (!hit || !text || this.tip.suppressedFor === hit.key) return;
    this.tip.key = hit.key;
    this.tip.state = 'waiting';
    this.tip.handle = this.clock.after(this.o.tooltipDelayMs, () => {
      if (this.tip.key !== hit.key || this.hover !== hit.key || this.menu) return;
      this.tip.state = 'shown'; this.tip.shownAt = this.clock.now;
      this._ev('tooltip_show', { key: hit.key, text: this._tipText(hit) });
      this._renderTooltip();
    });
  }

  _tipText(hit) {
    if (!hit) return null;
    if (hit.key === 'icon:quicktooth' || hit.key === 'ficon:quicktooth') return this.appIcon?.tip || null;
    if (hit.key === 'clock') return this.clockText().long;
    return hit.icon?.tip ?? hit.tip ?? null;
  }

  _hideTooltip(suppress = false) {
    this.tip.handle?.cancel();
    if (this.tip.state === 'shown') this._ev('tooltip_hide', { key: this.tip.key });
    if (suppress && this.tip.key) this.tip.suppressedFor = this.tip.key;
    this.tip.state = 'hidden';
    this.tip.key = null;
    this.dom.tooltip.style.display = 'none';
  }

  _renderTooltip() {
    const el = this.dom.tooltip;
    if (this.tip.state !== 'shown') { el.style.display = 'none'; return; }
    const hit = this.geom.items.find((i) => i.key === this.tip.key) ?? this.geom.flyout.cells.find((c) => c.key === this.tip.key);
    if (!hit) { el.style.display = 'none'; return; }
    const D = TASKBAR, T = this.T, r = (v) => this._r(v), css = (v) => `${this._css(v)}px`;
    const text = this._tipText(hit) ?? '';
    el.textContent = text;
    Object.assign(el.style, {
      display: 'block', background: T.tipBg, color: T.tipText, borderColor: T.tipBorder,
      font: `${this._css(r(12))}px ${UI_FONT}`, lineHeight: css(r(D.tipLine)),
      padding: `${css(r(D.tipPadTop) - 1)} ${css(r(D.tipPadX) - 1)} ${css(r(D.tipPadBottom) - 1)}`,
      borderRadius: css(r(D.tipRadius)), maxWidth: css(r(D.tipMaxW)), left: '0px', top: '0px',
    });
    const box = el.getBoundingClientRect();
    const w = Math.round(box.width * this.s), h = Math.round(box.height * this.s);
    const cx = Math.round((hit.left + hit.right) / 2);
    const above = this.tip.key.startsWith('ficon:') ? hit.top - r(6) : this.geom.tbTop - r(D.tipGap);
    const left = Math.max(0, Math.min(this.geom.W - w, cx - Math.round(w / 2)));
    el.style.left = css(left); el.style.top = css(above - h);
  }

  // ------------------------------------------------------------------ world events

  setTheme(theme) {
    if (theme === this.o.theme) return;
    this.o.theme = theme;
    this._ev('theme', { theme });
    this.layout();
    // WM_SETTINGCHANGE "ImmersiveColorSet" reaches the app a moment after the taskbar repaints.
    this.clock.after(30, () => this.app?.onSettingChange('ImmersiveColorSet'));
  }

  /** The page's devicePixelRatio was changed by the host (see main.js); re-layout and tell the app. */
  setScale(scale) {
    if (scale === this.o.scale) return;
    this.o.scale = scale;
    this._ev('scale', { scale });
    this.layout();
    this.clock.after(30, () => this.app?.onDisplayChange());
  }

  /** Explorer crashes/restarts: the taskbar and every icon vanish, then "TaskbarCreated" is broadcast. */
  restartExplorer() {
    this.explorerUp = false;
    this.appIcon = null;
    this.flyout.open = false;
    this.endMenu();
    this._ev('explorer_down');
    this.layout();
    this.clock.after(this.o.explorerRestartMs, () => {
      this.explorerUp = true;
      this._ev('explorer_up');
      this.layout();
      this.app?.onTaskbarCreated();
    });
  }

  setPromoted(promoted) {
    const exe = this.app?.exePath ?? EXE_PATH;
    const e = this.registry.ensure(exe, promoted ? 1 : 0);
    e.isPromoted = promoted ? 1 : 0; e.created = true;
    this._promotedChanged();
  }

  // ------------------------------------------------------------------ per-frame render

  render() {
    const T = this.T;
    if (this._clockEl) {
      const c = this.clockText();
      if (this._clockEl.dataset.v !== c.time + c.date) { this._clockEl.innerHTML = `<div>${c.time}</div><div>${c.date}</div>`; this._clockEl.dataset.v = c.time + c.date; }
    }
    // Hover / pressed pills (fade on the sim clock).
    for (const [key, { bg, it }] of this._els) {
      let level = this._fadeLevel(key);
      if (it.group === 'omni') level = Math.max(this._fadeLevel('volume'), this._fadeLevel('network'));
      const isPressed = this.pressed && (this.pressed.key === key || (it.group === 'omni' && this._els.get(this.pressed.key)?.it.group === 'omni'));
      // While a menu is open the taskbar keeps its last hover state (the menu loop has the mouse).
      const fill = isPressed ? T.pressed : T.hover;
      bg.style.background = fill;
      bg.style.opacity = String(isPressed ? 1 : level);
      const r = (v) => this._r(v), css = (v) => `${this._css(v)}px`;
      if (it.hover === 'cell') Object.assign(bg.style, { left: css(r(4)), top: css(r(4)), right: css(r(4)), bottom: css(r(4)), borderRadius: css(r(4)) });
      else if (it.group === 'omni') {
        const o = this.geom.omni, isNet = key === 'network', rad = css(r(TASKBAR.hoverRadius));
        Object.assign(bg.style, {
          left: css(isNet ? o.left - it.left : 0), right: css(isNet ? it.right - o.split : it.right - o.right),
          top: css(r(TASKBAR.hoverInsetY)), bottom: css(r(TASKBAR.hoverInsetY)),
          borderRadius: isNet ? `${rad} 0 0 ${rad}` : `0 ${rad} ${rad} 0`,
        });
      } else Object.assign(bg.style, { left: '0px', right: '0px', top: css(r(TASKBAR.hoverInsetY)), bottom: css(r(TASKBAR.hoverInsetY)), borderRadius: css(r(TASKBAR.hoverRadius)) });
    }
    // Tooltip fade-in.
    if (this.tip.state === 'shown') {
      const k = this.o.tooltipFadeMs > 0 ? Math.min(1, (this.clock.now - this.tip.shownAt) / this.o.tooltipFadeMs) : 1;
      this.dom.tooltip.style.opacity = String(k);
    }
    if (this._menuFading) this._composeMenus();
    // Flyout.
    this.dom.flyout.style.display = this.flyout.open ? 'block' : 'none';
    this.dom.pxFlyout.style.display = this.flyout.open ? 'block' : 'none';
    // Cursor.
    const cur = this.dom.cursor.style;
    cur.display = this.o.cursor && this.mouse.inside ? 'block' : 'none';
    cur.left = `${this._css(this.mouse.x)}px`; cur.top = `${this._css(this.mouse.y)}px`;
    cur.width = `${this._css(this._r(12))}px`; cur.height = `${this._css(this._r(19))}px`;
  }

  /** Where a named thing is on screen (physical px): 'icon', 'chevron', 'clock', 'menu:<text>', 'flyout-icon'… */
  locate(what) {
    if (what === 'icon') {
      const g = this.geom.items.find((i) => i.key === 'icon:quicktooth') ?? (this.flyout.open ? this.geom.flyout.cells.find((c) => c.key === 'ficon:quicktooth') : null);
      return g ? { left: g.left, top: g.top, right: g.right, bottom: g.bottom, x: (g.left + g.right) / 2, y: (g.top + g.bottom) / 2, inOverflow: g.key.startsWith('ficon') } : null;
    }
    if (what.startsWith('menu:')) {
      const label = what.slice(5);
      for (const w of this.menu?.windows ?? []) {
        const row = w.lay.rows.find((r) => !r.separator && (r.text === label || r.text.startsWith(label)));
        if (row) return { left: w.pos.left, top: w.pos.top + row.top, right: w.pos.left + w.lay.width, bottom: w.pos.top + row.top + row.height, x: w.pos.left + w.lay.width / 2, y: w.pos.top + row.top + row.height / 2 };
      }
      return null;
    }
    const g = this.geom.items.find((i) => i.key === what) ?? this.geom.flyout.cells.find((c) => c.key === what);
    return g ? { left: g.left, top: g.top, right: g.right, bottom: g.bottom, x: (g.left + g.right) / 2, y: (g.top + g.bottom) / 2 } : null;
  }

  snapshot() {
    return {
      scale: this.s, dpr: window.devicePixelRatio, screen: this.o.screen, theme: this.o.theme, explorerUp: this.explorerUp,
      icon: this.locate('icon'), iconInOverflow: !!this.appIcon && !this.geom.items.some((i) => i.key === 'icon:quicktooth'),
      hover: this.hover, tooltip: this.tip.state === 'shown' ? { key: this.tip.key, text: this.dom.tooltip.textContent } : null,
      menu: this.menu ? this.menu.windows.map((w) => ({ rect: [w.pos.left, w.pos.top, w.pos.left + w.lay.width, w.pos.top + w.lay.height], hot: w.hot >= 0 ? w.lay.rows[w.hot].text : null, items: w.lay.rows.map((r) => (r.separator ? '—' : `${r.checked ? '✓ ' : ''}${r.text}${r.grayed ? ' (grayed)' : ''}${r.submenu ? ' ▸' : ''}`)) })) : null,
      flyoutOpen: this.flyout.open,
      registry: this.registry.entries.map((e) => ({ key: e.key, isPromoted: e.isPromoted, created: !!e.created })),
    };
  }
}
