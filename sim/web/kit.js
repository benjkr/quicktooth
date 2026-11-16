// Loads the pieces shared by the simulator page and the parity check: the C# constants, the glyph
// SVGs from assets/, and an IconRenderer configured with any tunable overrides.
import { loadConstants } from './constants.js';
import { IconRenderer, parseGlyph } from './icon.js';

export async function fetchText(repoPath) {
  const res = await fetch('/' + repoPath.replace(/^\/+/, ''), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} for ${repoPath}`);
  return res.text();
}

/**
 * @param {object} [o]
 * @param {object} [o.overrides] constant/tunable overrides, e.g. { Travel: 2.4, AnimFrameMs: 50 }
 * @param {string} [o.fillSvg] repo path of an alternative connected glyph
 * @param {string} [o.lineSvg] repo path of an alternative not-connected glyph
 * @param {string} [o.variant] URL of a variant module (see web/variants/README.md)
 */
export async function loadKit({ overrides = {}, fillSvg = 'assets/airpods-pro-fill.svg', lineSvg = 'assets/airpods-pro-line.svg', variant } = {}) {
  const { values, provenance, warnings } = await loadConstants(fetchText);
  const P = { ...values, ...overrides };
  const glyphs = {
    fill: parseGlyph(await fetchText(fillSvg), fillSvg),
    line: parseGlyph(await fetchText(lineSvg), lineSvg),
  };
  let variantModule = null;
  if (variant) {
    variantModule = await import(variant);
    if (variantModule.constants) Object.assign(P, variantModule.constants, overrides);
  }
  const renderer = new IconRenderer(glyphs, P, variantModule);
  return { P, provenance, warnings, glyphs, renderer, variant: variantModule };
}
