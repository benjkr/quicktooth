// The Win32 popup menu (TrackPopupMenuEx with SetPreferredAppMode dark/light), rebuilt from
// measurements of a real menu on Windows 11 build 26300 at 96 DPI — see
// sim/reference/metrics.json and sim/reference/menu/*.png (captured by probe/menuprobe.cs).
//
// Geometry is in physical pixels (like the app sees it). At other display scales every metric is
// scaled and rounded; that part is extrapolated, not measured.

/** Measured at 100 % (96 DPI). */
export const MENU_METRICS = {
  font: '"Segoe UI", sans-serif',
  fontPx: 12,               // 9 pt menu font
  border: 1,                // window frame
  pad: 2,                   // frame → first item (items start 3 px in)
  itemH: 22,
  sepH: 9,
  sepLineY: 4,              // separator line row inside its 9 px slot
  sepInset: 9,              // separator line x inset from each window edge
  hotInset: 6,              // hover rect x inset from each window edge (= 3 px inside the item)
  hotRadius: 4,
  textX: 38,                // text origin from the window's left edge
  baselineY: 15,            // text baseline from the item top
  // width = textX + widest text (GDI: whole-pixel advance per glyph, no kerning) + rightPad
  // (+1 when an item has a submenu arrow). Fitted to the two measured menus: 267 px and 230 px.
  rightPad: 60,
  arrowExtra: 1,
  check: [[10.5, 11.4], [13.6, 14.3], [18.6, 8.5]], // check-mark polyline, item-relative, 1 px stroke
  arrow: { fromRight: 20.5, tipFromRight: 16.5, top: 7.5, mid: 11.5, bottom: 15.5 },
  submenuOverlapRight: 6,   // submenu opening to the right starts 6 px inside the parent
  submenuOverlapLeft: 3,    // …to the left ends 3 px inside the parent
  submenuTopOffset: -3,     // submenu window top = item top − 3
};

export const MENU_COLORS = {
  dark: { bg: '#2C2C2C', border: '#808080', text: '#FFFFFF', disabled: '#6D6D6D', hot: '#353535', sep: '#3E3E3E', glyph: '#F2F2F2' },
  light: { bg: '#F9F9F9', border: '#E5E5E5', text: '#000000', disabled: '#9F9F9F', hot: '#F0F0F0', sep: '#D7D7D7', glyph: '#282828' },
};

let measureCtx;
/** GDI-style advances: each glyph's advance rounded to whole pixels, no kerning (what menus get). */
function advances(text, fontPx, font) {
  measureCtx ??= new OffscreenCanvas(8, 8).getContext('2d');
  measureCtx.font = `${fontPx}px ${font}`;
  return [...text].map((ch) => Math.round(measureCtx.measureText(ch).width));
}
export function textWidth(text, fontPx, font = MENU_METRICS.font) { return advances(text, fontPx, font).reduce((a, b) => a + b, 0); }

/** Draws text glyph by glyph on whole-pixel advances, like GDI. */
function fillTextGdi(ctx, text, x, y, fontPx, font) {
  const adv = advances(text, fontPx, font);
  let cx = x;
  [...text].forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += adv[i]; });
}

/** Lays out one menu window (physical px) for the given items at display scale s. */
export function layoutMenu(items, s, M = MENU_METRICS) {
  const r = (v) => Math.round(v * s);
  const fontPx = M.fontPx * s;
  let maxText = 0;
  for (const it of items) if (!it.separator) maxText = Math.max(maxText, textWidth(it.text, fontPx, M.font));
  const arrow = items.some((it) => it.submenu) ? r(M.arrowExtra) : 0;
  const width = Math.ceil(r(M.textX) + maxText + r(M.rightPad) + arrow);
  let y = r(M.border + M.pad);
  const rows = items.map((it) => {
    const h = it.separator ? r(M.sepH) : r(M.itemH);
    const row = { ...it, top: y, height: h };
    y += h;
    return row;
  });
  return { width, height: y + r(M.border + M.pad), rows, s, fontPx };
}

/** TrackPopupMenuEx placement with TPM_BOTTOMALIGN | TPM_LEFTALIGN, clamped to the monitor (measured). */
export function placeMainMenu(lay, x, y, screen) {
  let left = x, top = y - lay.height;
  if (left + lay.width > screen.width) left = screen.width - lay.width;
  if (left < 0) left = 0;
  if (top < 0) top = Math.min(y, screen.height - lay.height);
  return { left, top };
}

/** Where a submenu opens next to its parent item (measured: right if it fits, else left). */
export function placeSubmenu(sub, parentPos, parentLay, row, screen, s, M = MENU_METRICS) {
  const r = (v) => Math.round(v * s);
  let left = parentPos.left + parentLay.width - r(M.submenuOverlapRight);
  if (left + sub.width > screen.width) left = parentPos.left + r(M.submenuOverlapLeft) - sub.width;
  if (left < 0) left = 0;
  let top = parentPos.top + row.top + r(M.submenuTopOffset);
  if (top + sub.height > screen.height) top = screen.height - sub.height;
  return { left, top };
}

/**
 * Renders one menu window into a canvas at physical resolution. `hot` = index of the highlighted row.
 * `dwm` adds Windows 11's DWM rounding + shadow (extrapolated: not visible in WM_PRINT captures).
 */
export function drawMenu(ctx, lay, { theme = 'dark', hot = -1, M = MENU_METRICS } = {}) {
  const C = MENU_COLORS[theme];
  const s = lay.s, r = (v) => Math.round(v * s);
  const W = lay.width, H = lay.height;
  ctx.save();
  ctx.fillStyle = C.border;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.bg;
  const b = r(M.border);
  ctx.fillRect(b, b, W - 2 * b, H - 2 * b);

  lay.rows.forEach((row, i) => {
    if (row.separator) {
      ctx.fillStyle = C.sep;
      ctx.fillRect(r(M.sepInset), row.top + r(M.sepLineY), W - 2 * r(M.sepInset), Math.max(1, Math.round(s)));
      return;
    }
    if (i === hot) {
      ctx.fillStyle = C.hot;
      ctx.beginPath();
      ctx.roundRect(r(M.hotInset), row.top, W - 2 * r(M.hotInset), row.height, M.hotRadius * s);
      ctx.fill();
    }
    ctx.fillStyle = row.grayed ? C.disabled : C.text;
    ctx.font = `${lay.fontPx}px ${M.font}`;
    ctx.textBaseline = 'alphabetic';
    fillTextGdi(ctx, row.text, r(M.textX), row.top + r(M.baselineY), lay.fontPx, M.font);
    const glyph = row.grayed ? C.disabled : C.glyph;
    ctx.strokeStyle = glyph;
    ctx.lineWidth = Math.max(1, s);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    if (row.checked) {
      ctx.beginPath();
      M.check.forEach(([x, y], k) => (k ? ctx.lineTo : ctx.moveTo).call(ctx, r(3) + x * s, row.top + y * s));
      ctx.stroke();
    }
    if (row.submenu) {
      const a = M.arrow;
      ctx.beginPath();
      ctx.moveTo(W - a.fromRight * s, row.top + a.top * s);
      ctx.lineTo(W - a.tipFromRight * s, row.top + a.mid * s);
      ctx.lineTo(W - a.fromRight * s, row.top + a.bottom * s);
      ctx.stroke();
    }
  });
  ctx.restore();
}

/** Index of the row at window-relative y, or -1. */
export function rowAt(lay, y) {
  return lay.rows.findIndex((row) => y >= row.top && y < row.top + row.height);
}

/** Next selectable row for keyboard navigation (Win32 menus skip separators, but disabled items can be selected). */
export function nextRow(lay, from, dir) {
  const n = lay.rows.length;
  for (let k = 1; k <= n; k++) {
    const i = ((from < 0 ? (dir > 0 ? -1 : 0) : from) + dir * k + n * 4) % n;
    if (!lay.rows[i].separator) return i;
  }
  return -1;
}
