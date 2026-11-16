// ffmpeg helpers: nearest-neighbour zoom for pixel inspection, and frame sequences → MP4 / GIF.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ffmpeg = (args) => run('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 1 << 26 });

export async function hasFfmpeg() {
  try { await run('ffmpeg', ['-version'], { windowsHide: true }); return true; } catch { return false; }
}

/** Upscales a PNG by an integer factor with no smoothing, so single pixels stay visible. */
export async function zoomPng(input, output, factor) {
  await ffmpeg(['-i', input, '-vf', `scale=iw*${factor}:ih*${factor}:flags=neighbor`, output]);
}

/** frames: printf-style pattern (e.g. dir/f%05d.png). Writes an H.264 MP4 at `fps`, optionally zoomed. */
export async function framesToMp4(pattern, fps, output, zoom = 1) {
  const vf = [`scale=trunc(iw*${zoom}/2)*2:trunc(ih*${zoom}/2)*2:flags=neighbor`];
  await ffmpeg(['-framerate', String(fps), '-i', pattern, '-vf', vf.join(','), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', '-preset', 'medium', output]);
}

/** Palette-optimised GIF (good for short UI loops). */
export async function framesToGif(pattern, fps, output, zoom = 1) {
  const scale = `scale=iw*${zoom}:ih*${zoom}:flags=neighbor`;
  await ffmpeg(['-framerate', String(fps), '-i', pattern, '-filter_complex', `${scale},split[a][b];[a]palettegen=stats_mode=full:max_colors=256[p];[b][p]paletteuse=dither=none`, '-loop', '0', output]);
}

const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

/** Stacks PNGs vertically (padding narrower ones), e.g. baseline over variant frame sheets. */
export async function stackPngs(files, output, readFileFn) {
  const sizes = [];
  for (const f of files) sizes.push(pngSize(await readFileFn(f)));
  const W = Math.max(...sizes.map((s) => s.w));
  const pads = files.map((_, i) => `[${i}]pad=${W}:ih+8:0:0:color=0x444444[p${i}]`).join(';');
  const stack = files.map((_, i) => `[p${i}]`).join('') + `vstack=inputs=${files.length}`;
  await ffmpeg([...files.flatMap((f) => ['-i', f]), '-filter_complex', `${pads};${stack}`, output]);
}
