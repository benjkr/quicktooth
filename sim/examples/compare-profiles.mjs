// The same click on several Bluetooth profiles, recorded frame-accurately and played side by side,
// so you can see what a slow, flaky or failing connection looks like in the taskbar.
//
//   bun examples/compare-profiles.mjs                      # fast vs slow, icon region at 6×
//   bun examples/compare-profiles.mjs fast flaky unreachable --region tray --zoom 1
//
// Writes sim/out/compare-profiles/<a>-vs-<b>….mp4 and .gif.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Session } from '../lib/session.mjs';
import { SIM_DIR } from '../lib/browser.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : def; };
const region = opt('region', 'icon');
const zoom = Number(opt('zoom', region === 'icon' ? 6 : 1));
const fps = 30;
const profiles = args.length ? args : ['fast', 'slow'];
const outDir = path.join(SIM_DIR, 'out', 'compare-profiles');

const dirs = [];
for (const profile of profiles) {
  const s = await Session.open({ profile });
  try {
    const dir = path.join(outDir, profile);
    await s.startRecording({ dir, fps, region });
    await s.moveTo('icon', 400);
    await s.advance(600);
    await s.click(null);
    const ic = await s.locate('icon');
    await s.moveTo(`${ic.x + 260},${ic.y - 300}`, 250); // move off the icon, as people do
    for (let i = 0; i < 30 * 25; i++) {
      const st = await s.state();
      if (!st.app.pending && !st.app.anim) break;
      await s.advance(1000 / fps);
    }
    await s.advance(1200);
    const v = await s.stopRecording({});
    const lines = (await s.log()).filter((l) => /confirmed|resending|timed out|no control|waited/.test(l)).map((l) => l.replace(/^.*?\] /, ''));
    console.log(`${profile.padEnd(12)} ${(v.frames / fps).toFixed(1)} s   ${lines.join(' | ')}`);
    dirs.push(dir);
  } finally {
    await s.close();
  }
}

const font = "fontfile='C\\:/Windows/Fonts/segoeui.ttf'";
const inputs = dirs.flatMap((d) => ['-framerate', String(fps), '-i', path.join(d, 'f%05d.png')]);
const filters = profiles.map((p, i) =>
  `[${i}]scale=iw*${zoom}:ih*${zoom}:flags=neighbor,tpad=stop_mode=clone:stop_duration=60,drawtext=text='${p}':x=10:y=8:fontsize=16:fontcolor=white:${font},pad=iw+12:ih:0:0:color=black[v${i}]`);
const stack = profiles.map((_, i) => `[v${i}]`).join('') + `hstack=inputs=${profiles.length}`;
// tpad keeps the shorter clips on their last frame; cut at the longest clip.
const longest = Math.max(...dirs.map((d) => Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-ChildItem '${d}' -Filter *.png).Count`]).toString().trim()))) / fps;
const mp4 = path.join(outDir, `${profiles.join('-vs-')}.mp4`);
execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', `${filters.join(';')};${stack}`, '-t', longest.toFixed(3), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '14', mp4]);
const gif = mp4.replace(/\.mp4$/, '.gif');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-filter_complex', 'fps=15,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none', gif]);
console.log(mp4);
console.log(gif);
