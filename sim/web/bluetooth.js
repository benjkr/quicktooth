// Mock of everything QuickTooth asks Windows about Bluetooth audio, at the same boundary the app
// uses (BluetoothAudio.Enumerate / SendOneShot, PnpEndpoints.BluetoothConnected / BluetoothBattery,
// the IMMNotificationClient callback, and the BLE battery advert scan). The app model in tray.js
// polls and reacts to this exactly like TrayApp does to the real stack, so its timers — the 200 ms
// debounce, 500 ms fast poll, 5 s teardown wait, 8 s resend, 20 s timeout — all come into play.
//
// What the model reproduces (from the README's measurements and the app's comments):
//  • Two links per headset: A2DP (music) and HFP (hands-free). On current Windows 11 the A2DP link
//    only comes up after HFP, so A2DP lands `a2dpAfterHfpMs` after HFP.
//  • The HFP render endpoint is hidden from Core Audio enumeration; its state-change notifications
//    may not fire (`notifyHidden`), which is why the app fast-polls while pending.
//  • After a disconnect the Bluetooth ACL link lingers (`lingerMs`, ~3 s). A connect sent into that
//    teardown stalls (`teardownStallMs`, 15 s+) — the app waits up to 5 s to avoid it.
//  • A connect request can be lost (`dropRate`, `dropFirst`), which the 8 s resend recovers; or never
//    land at all (`neverConnects`, out of range), which the 20 s timeout ends.
//  • The driver can refuse the one-shot (`ksReject`), which ends the attempt immediately.

export const STATE = { ACTIVE: 1, DISABLED: 2, NOTPRESENT: 4, UNPLUGGED: 8 };
const STATE_NAME = { 1: 'ACTIVE', 2: 'DISABLED', 4: 'NOTPRESENT', 8: 'UNPLUGGED' };
export const stateName = (s) => STATE_NAME[s] ?? `0x${s.toString(16)}`;

/**
 * Connection profiles. Every field can be overridden individually (bt.setProfile({...})).
 * Durations are [min, max] ms ranges, drawn with the seeded RNG.
 *
 * Calibration (the dev PC's real quicktooth.log, AirPods Pro 3, Nov 2026):
 *   19 connects confirmed after 1040 1511 1520 1524 1555 1700 2011 2028 2061 2362 2501 2519 2545
 *   3769 4021 4616 6574 9020 13047 ms (median 2.06 s; the 13 s one needed the 8 s resend). Both
 *   endpoints usually show ACTIVE in the same refresh; once HFP was seen first.
 *   21 disconnects: A2DP drops within ~50 ms of the request, HFP ~0.4 s later → confirmed after
 *   504–529 ms by the 500 ms poll; 3 of 21 took 3.3–3.6 s. After a disconnect the link stayed up
 *   ~3 s ("waited 815…2448 ms for the previous link to close", measured from the click).
 *   Battery adverts were read ~6.5 s after connecting; the case level was unknown ("case ?").
 */
export const PROFILES = {
  fast: {
    label: 'Fast — the README demo case (~1.1 s)',
    hfpMs: [750, 1000], a2dpAfterHfpMs: [0, 150],
  },
  typical: {
    label: 'Typical — the middle of the real log (confirmed after ~1.5–3 s), no surprises',
    hfpMs: [1100, 2600], a2dpAfterHfpMs: [0, 350],
  },
  'real-world': {
    label: 'Real-world mix — the real log incl. its slow tail, lost requests and slow disconnects',
    hfpMs: [1100, 2600], a2dpAfterHfpMs: [0, 350], hfpTailChance: 0.25, hfpTailMs: [3500, 9500], dropRate: 0.06, slowDisconnectChance: 0.15,
  },
  slow: {
    label: 'Slow page — lands after the 8 s resend',
    hfpMs: [8600, 10500], a2dpAfterHfpMs: [0, 400],
  },
  flaky: {
    label: 'Flaky — the first request is lost; the resend lands (the real 13 s case)',
    dropFirst: true, hfpMs: [1500, 2800], a2dpAfterHfpMs: [0, 350],
  },
  unreachable: {
    label: 'Unreachable — requests accepted, never land; 20 s timeout',
    neverConnects: true,
  },
  rejected: {
    label: 'Rejected — the driver refuses the request (hr 0x80070490)',
    ksReject: true,
  },
  'long-linger': {
    label: 'Long linger — the old link outlives the 5 s wait; the reconnect stalls',
    hfpMs: [1100, 2000], lingerMs: [6500, 7000], teardownStallMs: [15000, 18000],
  },
  'hfp-very-slow': {
    label: 'Hands-free very slow (what Quick Settings often hits) — 10–20 s',
    hfpMs: [10000, 20000], a2dpAfterHfpMs: [0, 400],
  },
};

export const PROFILE_DEFAULTS = {
  hfpMs: [1100, 2600],         // request → HFP endpoint ACTIVE
  hfpTailChance: 0,            // chance of a slow page instead…
  hfpTailMs: [3500, 9500],     // …taking this long
  a2dpAfterHfpMs: [0, 350],    // HFP ACTIVE → A2DP ACTIVE (A2DP waits for HFP on current Windows 11)
  disconnectA2dpMs: [20, 120], // disconnect request → A2DP UNPLUGGED
  disconnectHfpMs: [300, 480], // disconnect request → HFP UNPLUGGED
  slowDisconnectChance: 0,     // chance HFP takes…
  slowDisconnectMs: [3000, 3600], // …this long to drop instead
  lingerMs: [2800, 3300],      // last endpoint UNPLUGGED → ACL link closed
  teardownStallMs: [15000, 18000], // a connect sent while the link lingers lands only after this
  dropRate: 0,                 // chance any one connect request is silently lost
  dropFirst: false,            // the first connect request of each attempt is lost
  neverConnects: false,        // requests are accepted but never land
  ksReject: false,             // every KS one-shot returns an error HRESULT
  notifyMs: [20, 60],          // endpoint state change → IMMNotificationClient callback
  notifyHidden: false,         // whether hidden (HFP) endpoints notify at all
  enumerateMs: [5, 28],        // worker time for one BluetoothAudio.Enumerate (real disconnects confirm 504–529 ms after a 500 ms poll)
  sendMs: [4, 9],              // worker time for SendOneShot (real log: click → KsProperty 6–8 ms)
  pnpMs: [3, 8],               // worker time for PnpEndpoints.BluetoothConnected / BluetoothBattery
  bleHeard: true,              // AirPods status advert is heard during a battery scan
  bleScanMs: [2500, 5000],     // time to hear a strong advert (real: reading ~6.5 s after connecting)
};

let nextId = 1;
const guid = () => `{${(0xA1000000 + nextId++).toString(16)}-0000-4000-8000-${String(nextId).padStart(12, '0')}}`;

export function makeDevice({ name, mac, appleModel = null, connected = false, windowsBattery = null, battery = null, present = true, inRange = true } = {}) {
  const containerId = guid();
  const vid = appleModel != null ? `_vid&0001004c_pid&${appleModel.toString(16).padStart(4, '0')}` : '_vid&000105d6_pid&000a';
  const macLower = mac.toLowerCase();
  const mk = (kind, hidden) => ({
    kind, hidden,
    name: kind === 'A2DP' ? `Headphones (${name})` : `Headset (${name} Hands-Free)`,
    interfaceName: kind === 'A2DP' ? name : `${name} Hands-Free`,
    bthDeviceId: kind === 'A2DP'
      // String.raw: real device IDs read "{2}.\\?\bthenum#…\src" (a plain template would turn \b into a backspace).
      ? String.raw`{2}.\\?\bthenum#{0000110b-0000-1000-8000-00805f9b34fb}${vid}#7&2b3e0c1&0&${macLower}_c00000000#{6994ad04-93ef-11d0-a3cc-00a0c9223196}\src`
      : String.raw`{2}.\\?\bthhfenum#bthhfpaudio#8&3a4f1d2&0&${(nextId * 7) % 100}#{6994ad04-93ef-11d0-a3cc-00a0c9223196}\wave`,
    state: connected ? STATE.ACTIVE : STATE.UNPLUGGED,
  });
  return {
    containerId, name, mac: mac.toUpperCase(), appleModel, present, inRange,
    endpoints: [mk('A2DP', false), mk('HFP', true)],
    link: connected ? 'up' : 'down',   // ACL link: down | up | lingering
    windowsBattery,                    // % reported to Windows (non-AirPods), or null
    battery: battery ?? (appleModel != null ? { left: 80, right: 70, case: null, budsCharging: false, caseCharging: false } : null), // case unknown while the buds are out
    _pending: [],                      // scheduled clock handles for in-flight work
    _attempt: null,                    // { requests, landed }
  };
}

export class MockBluetooth {
  constructor(clock, rng, { profile = 'typical', devices } = {}) {
    this.clock = clock;
    this.rng = rng;
    this.devices = devices ?? [
      makeDevice({ name: 'AirPods Pro', mac: 'A0B1C2D3E4F5', appleModel: 0x2027 }),
      makeDevice({ name: 'Studio Headset', mac: '00AABBCCDDEE', windowsBattery: 70 }),
    ];
    this.listeners = new Set();
    this.events = [];            // world-side timeline (for logs and assertions)
    this.setProfile(profile);
  }

  setProfile(p) {
    if (typeof p === 'string') {
      if (!PROFILES[p]) throw new Error(`unknown profile "${p}" (have: ${Object.keys(PROFILES).join(', ')})`);
      this.profileName = p;
      this.profile = { ...PROFILE_DEFAULTS, ...PROFILES[p] };
    } else {
      this.profileName = p.name ?? 'custom';
      this.profile = { ...this.profile, ...p };
    }
    this._event(`profile ${this.profileName}`);
  }

  _ms(key) {
    const v = this.profile[key];
    return Array.isArray(v) ? Math.round(this.rng.range(v[0], v[1])) : v;
  }

  _event(text, device) {
    this.events.push({ t: this.clock.now, text: device ? `${device.name}: ${text}` : text });
    if (this.events.length > 2000) this.events.shift();
  }

  device(idOrName) {
    return this.devices.find((d) => d.containerId === idOrName || d.name === idOrName || d.mac === String(idOrName).toUpperCase()) ?? null;
  }

  onEndpointChanged(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _setEndpoint(d, ep, state) {
    if (ep.state === state) return;
    ep.state = state;
    this._event(`${ep.kind} → ${stateName(state)}`, d);
    if (!ep.hidden || this.profile.notifyHidden) {
      this.clock.after(this._ms('notifyMs'), () => { for (const fn of this.listeners) fn(ep.bthDeviceId); });
    }
  }

  _cancelPending(d) { for (const h of d._pending) h.cancel(); d._pending = []; }

  // ------------------------------------------------------------------ the app's view (worker calls)

  /** BluetoothAudio.Enumerate(): every present device with its endpoints, sorted by name. */
  enumerate() {
    return this.devices
      .filter((d) => d.present)
      .map((d) => ({
        containerId: d.containerId, name: d.name, mac: d.mac,
        endpoints: d.endpoints.map((e) => ({ kind: e.kind, state: e.state, hidden: e.hidden, name: e.name, bthDeviceId: e.bthDeviceId })),
        connected: d.endpoints.some((e) => e.state === STATE.ACTIVE),
        stateSignature: d.endpoints.map((e) => `${e.kind}=${stateName(e.state)}`).join(', '),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** PnpEndpoints.BluetoothConnected(mac): the ACL link's connected flag (true while it lingers). */
  bluetoothConnected(mac) {
    const d = this.devices.find((x) => x.mac === mac);
    if (!d || !d.present) return null;
    return d.link === 'up' || d.link === 'lingering';
  }

  /** PnpEndpoints.BluetoothBattery(mac): the level Windows knows, for headsets that report it (not AirPods). */
  windowsBattery(mac) {
    const d = this.devices.find((x) => x.mac === mac);
    return d && d.link === 'up' ? d.windowsBattery : null;
  }

  /**
   * BluetoothAudio.SendOneShot(containerId, op): the KS one-shot to both controls (A2DP first, then HFP).
   * Returns per-control results ({ endpointName, bthDeviceId, hr }).
   */
  sendOneShot(containerId, op) {
    const d = this.devices.find((x) => x.containerId === containerId && x.present);
    if (!d) return [];
    const hr = this.profile.ksReject ? 0x80070490 | 0 : 0; // ERROR_NOT_FOUND as HRESULT
    const results = d.endpoints.map((e) => ({ endpointName: e.name, bthDeviceId: e.bthDeviceId, hr }));
    if (hr < 0) { this._event(`${op} rejected by the driver (hr=0x80070490)`, d); return results; }
    if (op === 'Connect') this._connectRequest(d); else this._disconnectRequest(d);
    return results;
  }

  _connectRequest(d) {
    const p = this.profile;
    const attempt = d._attempt ??= { requests: 0, landed: false };
    attempt.requests++;
    if (d.endpoints.every((e) => e.state === STATE.ACTIVE)) { this._event('connect request: already connected', d); return; }
    if (d._connecting) { this._event('connect request: one already in flight (ignored)', d); return; }
    if (!d.inRange || p.neverConnects) { this._event('connect request accepted; the headset never answers', d); return; }
    if ((p.dropFirst && attempt.requests === 1) || this.rng.chance(p.dropRate)) { this._event('connect request lost', d); return; }

    let start = 0;
    if (d.link === 'lingering') {
      start = this._ms('teardownStallMs');
      this._event(`connect sent into a closing link: stalls ${start} ms`, d);
    }
    const hfp = start + (this.rng.chance(p.hfpTailChance) ? this._ms('hfpTailMs') : this._ms('hfpMs'));
    const a2dp = hfp + this._ms('a2dpAfterHfpMs');
    d._connecting = true;
    this._event(`connect request: HFP in ${hfp} ms, A2DP in ${a2dp} ms`, d);
    const hfpEp = d.endpoints.find((e) => e.kind === 'HFP'), a2dpEp = d.endpoints.find((e) => e.kind === 'A2DP');
    d._pending.push(this.clock.after(hfp, () => {
      if (d.lingerHandle) { d.lingerHandle.cancel(); d.lingerHandle = null; }
      d.link = 'up';
      this._setEndpoint(d, hfpEp, STATE.ACTIVE);
    }));
    d._pending.push(this.clock.after(a2dp, () => {
      this._setEndpoint(d, a2dpEp, STATE.ACTIVE);
      d._connecting = false;
      attempt.landed = true;
      d._attempt = null;
    }));
  }

  _disconnectRequest(d) {
    this._cancelPending(d);
    d._connecting = false;
    d._attempt = null;
    if (d.link === 'down') { this._event('disconnect request: not connected', d); return; }
    const p = this.profile;
    const a2dpMs = this._ms('disconnectA2dpMs');
    const hfpMs = Math.max(a2dpMs, this.rng.chance(p.slowDisconnectChance) ? this._ms('slowDisconnectMs') : this._ms('disconnectHfpMs'));
    this._event(`disconnect request: A2DP drops in ${a2dpMs} ms, HFP in ${hfpMs} ms`, d);
    const [a2dpEp, hfpEp] = [d.endpoints.find((e) => e.kind === 'A2DP'), d.endpoints.find((e) => e.kind === 'HFP')];
    d._pending.push(this.clock.after(a2dpMs, () => this._setEndpoint(d, a2dpEp, STATE.UNPLUGGED)));
    d._pending.push(this.clock.after(hfpMs, () => this._dropLink(d, 'requested')));
  }

  /** Endpoints go UNPLUGGED; the ACL link lingers before closing. */
  _dropLink(d, why) {
    for (const e of d.endpoints) this._setEndpoint(d, e, STATE.UNPLUGGED);
    d.link = 'lingering';
    const linger = this._ms('lingerMs');
    this._event(`link lingers ${linger} ms (${why})`, d);
    d.lingerHandle = this.clock.after(linger, () => { d.link = 'down'; d.lingerHandle = null; this._event('link closed', d); });
  }

  /**
   * BleBatteryScanner.ScanAsync(model, window): passive scan for the AirPods status advert.
   * Resolves with a reading as soon as a strong advert is heard, else null when the window ends.
   */
  bleScan(model, windowMs) {
    const d = this.devices.find((x) => x.appleModel === model && x.present && x.link === 'up');
    return new Promise((resolve) => {
      if (!d || !this.profile.bleHeard || !d.battery) { this.clock.after(windowMs, () => resolve(null)); return; }
      const ms = Math.min(windowMs, this._ms('bleScanMs'));
      this.clock.after(ms, () => {
        const b = d.battery;
        resolve({ left: b.left, right: b.right, case: b.case, budsCharging: b.budsCharging, caseCharging: b.caseCharging, rssi: -58, source: 'ble' });
      });
    });
  }

  // ------------------------------------------------------------------ the world (things the user or headset do)

  /** The headset connects on its own (taken out of the case near the PC, or another app connected it). */
  externalConnect(id) {
    const d = this.device(id); if (!d) throw new Error(`no device ${id}`);
    this._cancelPending(d);
    d.link = 'up';
    if (d.lingerHandle) { d.lingerHandle.cancel(); d.lingerHandle = null; }
    this._event('connected externally', d);
    for (const e of d.endpoints) this._setEndpoint(d, e, STATE.ACTIVE);
  }

  /** The headset drops (put in the case, walked out of range, or taken over by a phone). */
  externalDisconnect(id) {
    const d = this.device(id); if (!d) throw new Error(`no device ${id}`);
    this._cancelPending(d);
    d._connecting = false;
    if (d.link === 'down') return;
    this._event('disconnected externally', d);
    this._dropLink(d, 'external');
  }

  setInRange(id, inRange) { const d = this.device(id); d.inRange = inRange; this._event(inRange ? 'back in range' : 'out of range', d); if (!inRange) this.externalDisconnect(id); }

  /** Unpaired or removed: the device's endpoints vanish from enumeration. */
  setPresent(id, present) {
    const d = this.device(id); if (!d) throw new Error(`no device ${id}`);
    if (!present) { this._cancelPending(d); for (const e of d.endpoints) e.state = STATE.NOTPRESENT; d.link = 'down'; }
    else for (const e of d.endpoints) e.state = STATE.UNPLUGGED;
    d.present = present;
    this._event(present ? 'paired / present' : 'removed (not present)', d);
    this.clock.after(this._ms('notifyMs'), () => { for (const fn of this.listeners) fn(d.endpoints[0].bthDeviceId); });
  }

  setBattery(id, battery) { const d = this.device(id); d.battery = battery ? { ...d.battery, ...battery } : null; this._event(`battery ${JSON.stringify(d.battery)}`, d); }

  addDevice(spec) { const d = makeDevice(spec); this.devices.push(d); this._event('added', d); this.clock.after(this._ms('notifyMs'), () => { for (const fn of this.listeners) fn(d.endpoints[0].bthDeviceId); }); return d; }

  /** Compact world snapshot for the panel and for assertions. */
  snapshot() {
    return this.devices.map((d) => ({
      name: d.name, containerId: d.containerId, mac: d.mac, present: d.present, inRange: d.inRange, link: d.link,
      a2dp: stateName(d.endpoints[0].state), hfp: stateName(d.endpoints[1].state), connecting: !!d._connecting,
      battery: d.battery, windowsBattery: d.windowsBattery,
    }));
  }
}
