// Light theme: amber text (accent and warnings) stays readable, at least 4.5:1 (WCAG AA for small text),
// on every surface it is drawn on. Values are read from app.css, so a later tweak cannot slip under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');
const light = css.match(/:root\[data-theme="light"\] \{([^}]*)\}/)[1];
const token = name => light.match(new RegExp(`--${name}:([^;]+);`))[1].trim();

// '#RRGGBB' or 'rgb(r g b / a)' over a solid background → [r, g, b]
function solid(color, under = [255, 255, 255]) {
  if (color.startsWith('#')) return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const [r, g, b, a = 1] = color.match(/[\d.]+/g).map(Number);
  return [r, g, b].map((c, i) => Math.round(c * a + under[i] * (1 - a)));
}
const lum = rgb => { const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('light amber text reaches 4.5:1 on every light surface it is used on', () => {
  const surface = solid(token('surface'));
  const backs = { paper: solid(token('paper')), surface, sunken: solid(token('sunken')), hover: solid(token('hover')),
    'warn-soft': solid(token('warn-soft'), surface), 'accent-soft': solid(token('accent-soft'), surface) };
  for (const fg of ['accent-text', 'warn']) {
    for (const [name, bg] of Object.entries(backs)) {
      const r = ratio(solid(token(fg)), bg);
      assert.ok(r >= 4.5, `--${fg} on --${name}: ${r.toFixed(2)}:1`);
    }
  }
});
