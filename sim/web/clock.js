// One virtual clock drives everything in the simulator: the app's Win32 timers, its awaits, the
// mock Bluetooth stack, and shell visuals (tooltip delay, menu fade, submenu hover delay).
// Nothing visual uses CSS transitions or real setTimeout, so stepping the clock and taking a
// screenshot always shows exactly the frame the real system would show at that moment.
//
// Modes:
//   realtime — time follows the wall clock × speed (0 = paused). For people watching.
//   manual   — time moves only via advance(ms). For agents: deterministic, as fast as possible.

const macrotask = (() => {
  const ch = new MessageChannel();
  const waiters = [];
  ch.port1.onmessage = () => waiters.shift()?.();
  return () => new Promise((r) => { waiters.push(r); ch.port2.postMessage(0); });
})();

export class SimClock {
  constructor({ mode = 'realtime', speed = 1 } = {}) {
    this.now = 0;              // virtual milliseconds since the simulation started
    this.mode = mode;
    this.speed = speed;
    this._events = [];         // { due, seq, fn, cancelled }
    this._seq = 0;
    this._running = false;
    this._frameListeners = new Set();
    this._lastReal = performance.now();
    if (mode === 'realtime') this._startRealtime();
  }

  /** Runs fn at virtual time `due` (absolute ms). Returns a handle with cancel(). */
  at(due, fn) {
    const ev = { due: Math.max(due, this.now), seq: this._seq++, fn, cancelled: false };
    // Keep sorted by (due, seq); the queue is small, insertion is fine.
    let i = this._events.length;
    while (i > 0 && (this._events[i - 1].due > ev.due || (this._events[i - 1].due === ev.due && this._events[i - 1].seq > ev.seq))) i--;
    this._events.splice(i, 0, ev);
    return { cancel: () => { ev.cancelled = true; }, get due() { return ev.due; } };
  }

  after(ms, fn) { return this.at(this.now + ms, fn); }

  /** A promise that resolves after `ms` of virtual time. */
  delay(ms) { return new Promise((resolve) => this.after(ms, resolve)); }

  /** Like System.Diagnostics.Stopwatch, on virtual time. */
  stopwatch() {
    const clock = this;
    return {
      start: clock.now, running: true,
      restart() { this.start = clock.now; this.running = true; return this; },
      get elapsedMs() { return clock.now - this.start; },
      get elapsedSeconds() { return (clock.now - this.start) / 1000; },
    };
  }

  /** Called after every batch of events, and every animation frame in realtime mode. */
  onFrame(fn) { this._frameListeners.add(fn); return () => this._frameListeners.delete(fn); }

  _emitFrame() { for (const fn of this._frameListeners) { try { fn(this.now); } catch (e) { console.error(e); } } }

  // In order, letting async continuations (the app's awaits) settle between events.
  /** Runs every event due up to `target`. Overlapping calls queue up behind the one in flight. */
  runUntil(target) {
    const run = () => this._runUntil(typeof target === 'function' ? target() : target);
    this._chain = (this._chain ?? Promise.resolve()).then(run, run);
    return this._chain;
  }

  async _runUntil(target) {
    this._running = true;
    try {
      for (;;) {
        const ev = this._events[0];
        if (!ev || ev.due > target) break;
        this._events.shift();
        if (ev.cancelled) continue;
        this.now = ev.due;
        try { ev.fn(); } catch (e) { console.error('[sim clock] event failed', e); }
        await macrotask(); // let promise continuations (awaits in the app model) run at this instant
      }
      if (target > this.now) this.now = target;
      await macrotask();
    } finally {
      this._running = false;
    }
    this._emitFrame();
  }

  /** Manual mode: advance virtual time by ms. */
  advance(ms) { return this.runUntil(() => this.now + Math.max(0, ms)); }

  /** Lets pending zero-delay work settle without moving time. */
  settle() { return this.runUntil(() => this.now); }

  setMode(mode, speed = this.speed) {
    this.mode = mode;
    this.speed = speed;
    this._lastReal = performance.now();
    if (mode === 'realtime') this._startRealtime();
  }

  _startRealtime() {
    if (this._rafActive) return;
    this._rafActive = true;
    const tick = async () => {
      if (this.mode !== 'realtime') { this._rafActive = false; return; }
      const real = performance.now();
      const dt = Math.min(250, real - this._lastReal) * this.speed; // cap catch-up after a stall
      this._lastReal = real;
      if (!this._running) await this.runUntil(() => this.now + dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  get pendingEvents() { return this._events.filter((e) => !e.cancelled).length; }
}

/** Small seeded PRNG (mulberry32), so jittered delays replay identically for a given seed. */
export function seededRandom(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (min, max) => (max <= min ? min : min + (max - min) * next());
  next.chance = (p) => p > 0 && next() < p;
  return next;
}
