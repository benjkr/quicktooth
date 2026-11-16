// Runs a scenario: a JSON list of steps (mouse actions, waits in virtual time, world events,
// screenshots, assertions) against a Session. See sim/README.md for the step reference.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Session } from './session.mjs';

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** expect: { "app.tooltip": "AirPods Pro — Connected", "app.pending": null, "shell.menu.0.items": {"includes": "Disconnect"} } */
export function checkExpect(state, spec) {
  const failures = [];
  for (const [p, want] of Object.entries(spec)) {
    const got = get(state, p);
    let ok;
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if ('match' in want) ok = typeof got === 'string' && new RegExp(want.match).test(got);
      else if ('includes' in want) ok = (Array.isArray(got) || typeof got === 'string') && got.includes(want.includes);
      else if ('approx' in want) ok = typeof got === 'number' && Math.abs(got - want.approx) <= (want.tol ?? 1);
      else if ('min' in want || 'max' in want) ok = typeof got === 'number' && got >= (want.min ?? -Infinity) && got <= (want.max ?? Infinity);
      else if ('not' in want) ok = JSON.stringify(got) !== JSON.stringify(want.not);
      else ok = JSON.stringify(got) === JSON.stringify(want);
    } else ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures.push(`${p}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  return failures;
}

/**
 * @param {object} scenario { name, options, region, record:{fps,zoom,gif}, steps:[…] }
 * @param {object} o { outDir, overrides (session options from the CLI), log }
 */
export async function runScenario(scenario, { outDir, overrides = {}, log = console.log, headless = true } = {}) {
  const name = scenario.name ?? 'scenario';
  const dir = path.join(outDir, name);
  await mkdir(dir, { recursive: true });
  const session = await Session.open({ ...(scenario.options ?? {}), ...overrides, headless });
  const result = { name, dir, steps: [], shots: [], failures: [], video: null };
  const region = scenario.region ?? 'tray';
  let shotN = 0;
  const t0 = await session.eval(() => window.qt.now);
  try {
    if (scenario.record) {
      await session.startRecording({ dir: path.join(dir, 'frames'), fps: scenario.record.fps ?? 30, region: scenario.record.region ?? region });
    }
    for (const [i, step] of (scenario.steps ?? []).entries()) {
      const [kind] = Object.keys(step).filter((k) => !['ms', 'button', 'timeout', 'zoom', 'region', 'label', 'step'].includes(k));
      const arg = step[kind];
      const tBefore = await session.eval(() => window.qt.now);
      let note = '';
      switch (kind) {
        case 'hover': await session.moveTo(arg, step.ms ?? 0); break;
        case 'move': await session.moveTo(arg, step.ms ?? 0); break;
        case 'click': await session.click(arg, { moveMs: step.ms ?? 0 }); break;
        case 'rightClick': await session.click(arg, { button: 'right', moveMs: step.ms ?? 0 }); break;
        case 'doubleClick': await session.click(arg, { moveMs: step.ms ?? 0 }); await session.advance(120); await session.click(null); break;
        case 'key': await session.page.keyboard.press(arg); await session.eval(() => window.qt.clock.settle()); break;
        case 'wait': await session.advance(arg); break;
        case 'waitFor': {
          // A JS expression over the state `s`, e.g. "s.app.pending === null && !s.app.anim"
          const timeout = step.timeout ?? 30000, stepMs = step.step ?? 10;
          let ok = false, waited = 0;
          const pred = new Function('s', `return (${arg});`);
          while (waited <= timeout) {
            if (pred(await session.state())) { ok = true; break; }
            await session.advance(stepMs);
            waited += stepMs;
          }
          note = ok ? `after ${waited} ms` : `TIMED OUT after ${timeout} ms`;
          if (!ok) result.failures.push(`step ${i + 1} waitFor(${arg}) timed out after ${timeout} ms`);
          break;
        }
        case 'shot': {
          const file = path.join(dir, `${String(++shotN).padStart(2, '0')}-${arg}.png`);
          await session.shot({ region: step.region ?? region, file, zoom: step.zoom ?? scenario.zoom ?? 1 });
          result.shots.push(file);
          note = file;
          break;
        }
        case 'expect': {
          // "log": "text" / "logNot": "text" — some (no) quicktooth.log line contains the text.
          const { log: logHas, logNot, ...rest } = arg;
          const f = checkExpect(await session.state(), rest);
          if (logHas || logNot) {
            const lines = await session.log();
            for (const want of [].concat(logHas ?? [])) if (!lines.some((l) => l.includes(want))) f.push(`log: no line contains ${JSON.stringify(want)}`);
            for (const bad of [].concat(logNot ?? [])) if (lines.some((l) => l.includes(bad))) f.push(`log: unexpected line containing ${JSON.stringify(bad)}`);
          }
          for (const x of f) result.failures.push(`step ${i + 1} ${step.label ?? 'expect'}: ${x}`);
          note = f.length ? `FAIL ${f.join('; ')}` : 'ok';
          break;
        }
        case 'profile': await session.eval((p) => window.qt.profile(p), arg); break;
        case 'theme': await session.eval((t) => window.qt.setTheme(t), arg); await session.advance(0); break;
        case 'scale': await session.eval((s) => window.qt.setScale(s), arg); await session.advance(0); break;
        case 'cli': note = await session.eval((a) => window.qt.cli(a), arg); await session.eval(() => window.qt.clock.settle()); break;
        case 'bt': { const [fn, ...args] = arg; await session.eval(([fn, args]) => window.qt.bt[fn](...args), [fn, args]); await session.eval(() => window.qt.clock.settle()); break; }
        case 'tune': await session.eval((o) => window.qt.tune(o), arg); break;
        case 'eval': note = JSON.stringify(await session.eval((code) => { const qt = window.qt; return eval(code); }, arg)) ?? ''; break;
        default: throw new Error(`step ${i + 1}: unknown step ${JSON.stringify(step)}`);
      }
      const tAfter = await session.eval(() => window.qt.now);
      result.steps.push({ i: i + 1, kind, arg, t: +(tBefore - t0).toFixed(1), dt: +(tAfter - tBefore).toFixed(1), note });
      log(`  ${String(i + 1).padStart(2)}. t=${((tBefore - t0) / 1000).toFixed(3)}s ${kind} ${typeof arg === 'string' ? arg : JSON.stringify(arg)}${note ? '  → ' + note : ''}`);
    }
    if (scenario.record) {
      const z = scenario.record.zoom ?? 1;
      result.video = await session.stopRecording({ mp4: path.join(dir, `${name}.mp4`), gif: scenario.record.gif === false ? null : path.join(dir, `${name}.gif`), zoom: z });
      log(`  video: ${result.video.frames} frames @ ${result.video.fps} fps (${result.video.seconds.toFixed(2)} s virtual = real time) → ${result.video.mp4}`);
    }
    const final = await session.state();
    await writeFile(path.join(dir, 'quicktooth.log'), (await session.log()).join('\n') + '\n');
    await writeFile(path.join(dir, 'timeline.json'), JSON.stringify(await session.timeline(), null, 1));
    await writeFile(path.join(dir, 'final-state.json'), JSON.stringify(final, null, 2));
    result.final = final;
  } finally {
    await session.close();
  }
  await writeFile(path.join(dir, 'result.json'), JSON.stringify({ ...result, final: undefined }, null, 2));
  result.ok = result.failures.length === 0;
  return result;
}
