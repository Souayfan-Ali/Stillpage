import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { contrastRatio, tokenBlocks } from './contrast.js';

/**
 * P1-39 / UI notes §9, §11: every colour pair the components use meets WCAG 2.2 AA in both themes:
 * text ≥ 4.5:1 (1.4.3), control boundaries and the focus ring ≥ 3:1 (1.4.11, 2.4.7).
 */
const CSS = readFileSync(path.resolve(import.meta.dirname, '../../../src/ui/tokens.css'), 'utf8');
const TEXT = 4.5;
const NON_TEXT = 3;

const LIGHT = ':root';
const DARK_MEDIA = ":root:not([data-theme='light'])";
const DARK_FORCED = ":root[data-theme='dark']";

/** [foreground, background, minimum ratio, where it is used]. */
const PAIRS: readonly (readonly [string, string, number, string])[] = [
  ['--color-text', '--color-bg', TEXT, 'body text'],
  ['--color-text', '--color-surface', TEXT, 'text on cards'],
  ['--color-text-muted', '--color-bg', TEXT, 'descriptions'],
  ['--color-text-muted', '--color-surface', TEXT, 'descriptions on cards'],
  ['--color-accent', '--color-bg', TEXT, 'accent text and links'],
  ['--color-on-accent', '--color-accent', TEXT, 'primary button, selected level'],
  ['--color-on-accent', '--color-accent-hover', TEXT, 'primary button hovered'],
  ['--color-text', '--color-accent-soft', TEXT, 'quiet button hovered'],
  ['--color-control-border', '--color-bg', NON_TEXT, 'radio and button outlines'],
  ['--color-control-border', '--color-surface', NON_TEXT, 'outlines on cards'],
  ['--color-accent', '--color-surface', NON_TEXT, 'selected segment edge on cards'],
  ['--color-focus', '--color-bg', NON_TEXT, 'focus ring'],
  ['--color-focus', '--color-surface', NON_TEXT, 'focus ring on cards'],
  ['--color-ok', '--color-bg', TEXT, 'protected state icon and text'],
  ['--color-warning', '--color-warning-soft', TEXT, 'warning banner icon'],
  ['--color-text', '--color-warning-soft', TEXT, 'warning banner text'],
  ['--color-error', '--color-error-soft', TEXT, 'error banner icon'],
  ['--color-text', '--color-error-soft', TEXT, 'error banner text'],
  ['--color-text', '--color-info-soft', TEXT, 'info banner text'],
  ['--color-control-border', '--color-warning-soft', NON_TEXT, 'buttons inside a warning banner'],
  ['--color-control-border', '--color-info-soft', NON_TEXT, 'buttons inside an info banner'],
  ['--color-control-border', '--color-error-soft', NON_TEXT, 'buttons inside an error banner'],
  ['--color-focus', '--color-warning-soft', NON_TEXT, 'focus ring inside a warning banner'],
  ['--color-focus', '--color-info-soft', NON_TEXT, 'focus ring inside an info banner'],
  ['--color-on-accent', '--color-accent', TEXT, 'primary button inside a banner'],
  // P3-16: the full pages' tinted canvas behind cards, and accent text on the soft accent (current nav item).
  ['--color-text', '--color-canvas', TEXT, 'text on the page canvas'],
  ['--color-text-muted', '--color-canvas', TEXT, 'descriptions on the page canvas'],
  ['--color-accent', '--color-canvas', TEXT, 'links on the page canvas'],
  ['--color-control-border', '--color-canvas', NON_TEXT, 'outlines on the page canvas'],
  ['--color-focus', '--color-canvas', NON_TEXT, 'focus ring on the page canvas'],
  ['--color-accent', '--color-accent-soft', TEXT, 'current navigation item'],
  // P3-18 (bold redesign): white on both stops of the brand gradient (panel band, dashboard sidebar, heroes).
  ['--color-on-brand', '--color-brand-start', TEXT, 'text on the brand gradient, start'],
  ['--color-on-brand', '--color-brand-end', TEXT, 'text on the brand gradient, end'],
  ['--color-on-brand-muted', '--color-brand-start', TEXT, 'secondary text on the brand gradient, start'],
  ['--color-on-brand-muted', '--color-brand-end', TEXT, 'secondary text on the brand gradient, end'],
  ['--color-on-brand', '--color-brand-current', TEXT, 'sidebar item hovered'],
  ['--color-accent', '--color-bg', TEXT, 'current sidebar item (a white pill)'],
  ['--color-focus-on-brand', '--color-brand-start', NON_TEXT, 'focus ring on the brand gradient, start'],
  ['--color-focus-on-brand', '--color-brand-end', NON_TEXT, 'focus ring on the brand gradient, end'],
  // State heroes: tinted card, its text, its badge glyph, and controls on it.
  ['--color-text', '--color-ok-soft', TEXT, 'text on the protected hero'],
  ['--color-ok', '--color-ok-soft', TEXT, 'state line on the protected hero'],
  ['--color-text', '--color-neutral-soft', TEXT, 'text on the off / no-access hero'],
  ['--color-text-muted', '--color-neutral-soft', TEXT, 'state line on the neutral hero'],
  ['--color-on-strong', '--color-ok-strong', NON_TEXT, 'protected badge glyph'],
  ['--color-on-strong', '--color-warning-strong', NON_TEXT, 'paused / warning badge glyph'],
  ['--color-on-strong', '--color-neutral-strong', NON_TEXT, 'off badge glyph'],
  ['--color-on-strong', '--color-info-strong', NON_TEXT, 'info badge glyph'],
  ['--color-on-strong', '--color-error', NON_TEXT, 'error badge glyph'],
  ['--color-control-border', '--color-ok-soft', NON_TEXT, 'buttons on the protected hero'],
  ['--color-control-border', '--color-neutral-soft', NON_TEXT, 'buttons on the neutral hero'],
  ['--color-focus', '--color-ok-soft', NON_TEXT, 'focus ring on the protected hero'],
  ['--color-focus', '--color-neutral-soft', NON_TEXT, 'focus ring on the neutral hero'],
  ['--color-focus', '--color-error-soft', NON_TEXT, 'focus ring on the error hero'],
  ['--color-on-accent', '--color-info-strong', TEXT, 'primary button on the info hero'],
  // Stat tiles (ads / trackers / companies): coloured figure and label on their own tint.
  ['--color-ads', '--color-ads-soft', TEXT, 'ads tile'],
  ['--color-trackers', '--color-trackers-soft', TEXT, 'trackers tile'],
  ['--color-companies', '--color-companies-soft', TEXT, 'companies tile'],
  ['--color-text', '--color-ads-soft', TEXT, 'text on the ads tile'],
  ['--color-text', '--color-trackers-soft', TEXT, 'text on the trackers tile'],
  ['--color-text', '--color-companies-soft', TEXT, 'text on the companies tile'],
  // Coloured levels: a filled selected segment and a tinted unselected one, each with its own hue.
  ['--color-on-level', '--color-level-light', TEXT, 'selected Light'],
  ['--color-on-level', '--color-level-standard', TEXT, 'selected Standard'],
  ['--color-on-level', '--color-level-thorough', TEXT, 'selected Thorough'],
  ['--color-level-light', '--color-level-light-soft', TEXT, 'Light, not selected'],
  ['--color-level-standard', '--color-level-standard-soft', TEXT, 'Standard, not selected'],
  ['--color-level-thorough', '--color-level-thorough-soft', TEXT, 'Thorough, not selected'],
  ['--color-level-light', '--color-bg', NON_TEXT, 'selected Light edge'],
  ['--color-level-standard', '--color-bg', NON_TEXT, 'selected Standard edge'],
  ['--color-level-thorough', '--color-bg', NON_TEXT, 'selected Thorough edge'],
  ['--color-focus', '--color-level-light-soft', NON_TEXT, 'focus ring on a level segment'],
  ['--color-focus', '--color-level-thorough-soft', NON_TEXT, 'focus ring on a level segment'],
  // Tinted action rows and the saved banner.
  ['--color-text', '--color-accent-soft', TEXT, 'tinted rows and the saved banner'],
  ['--color-accent', '--color-surface', TEXT, 'row icons and chevrons on cards'],
  ['--color-focus', '--color-accent-soft', NON_TEXT, 'focus ring on tinted rows'],
  ['--color-control-border', '--color-accent-soft', NON_TEXT, 'buttons on the saved banner'],
  ['--color-track', '--color-bg', NON_TEXT, 'switch track (off) and meter track'],
  ['--color-track', '--color-surface', NON_TEXT, 'switch track (off) on cards'],
];

const blocks = tokenBlocks(CSS);
const theme = (selector: string): Readonly<Record<string, string>> => {
  const found = blocks.get(selector);
  if (found === undefined) throw new Error(`no token block for ${selector}`);
  return found;
};
const resolved = (selector: string): Readonly<Record<string, string>> => ({
  ...theme(LIGHT),
  ...theme(selector),
});

describe('tokens.css', () => {
  test('defines a light theme, a dark theme by media query and a forced dark theme', () => {
    expect([...blocks.keys()]).toEqual(expect.arrayContaining([LIGHT, DARK_MEDIA, DARK_FORCED]));
  });

  test('the media-query dark theme and the forced dark theme are identical', () => {
    expect(theme(DARK_MEDIA)).toEqual(theme(DARK_FORCED));
  });

  test('the dark theme redefines every colour of the light theme', () => {
    const colours = Object.keys(theme(LIGHT)).filter((k) => k.startsWith('--color-'));
    expect(Object.keys(theme(DARK_MEDIA)).sort()).toEqual(colours.sort());
  });

  test.each([
    ['light', LIGHT],
    ['dark', DARK_MEDIA],
  ])('every colour pair meets WCAG AA in the %s theme', (_name, selector) => {
    const tokens = resolved(selector);
    const failures = PAIRS.map(([fg, bg, min, use]) => ({
      use,
      fg,
      bg,
      min,
      ratio: contrastRatio(tokens[fg] ?? '', tokens[bg] ?? ''),
    }))
      .filter((pair) => pair.ratio < pair.min)
      .map((pair) => `${pair.use}: ${pair.fg} on ${pair.bg} = ${pair.ratio.toFixed(2)} < ${String(pair.min)}`);
    expect(failures).toEqual([]);
  });
});

describe('contrast helper', () => {
  test('black on white is 21:1 and a colour on itself is 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#0a6e69', '#0a6e69')).toBe(1);
  });

  test('rejects anything but #rrggbb', () => {
    expect(() => contrastRatio('teal', '#ffffff')).toThrow(/not a #rrggbb/);
  });
});
