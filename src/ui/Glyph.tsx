/**
 * The interface's icon set (P3-18): one 16-unit grid, one 1.6 stroke in `currentColor`, round ends, drawn as
 * path data only (a few hundred bytes for the whole set; no icon library, no file, no request). Decorative:
 * the text next to a glyph carries the meaning, so it is hidden from assistive technology. The state icons
 * with their own shapes for WCAG 1.4.1 stay in `Icon.tsx`.
 */
import type { JSX } from 'preact';

const DEFAULT_SIZE = 16;

/** A still wave across the grid at height `y`: the logo's waves, one per level of protection. */
const wave = (y: number): string => `M2 ${String(y)}c1.3-1.1 2.7-1.1 4 0s2.7 1.1 4 0 2.7-1.1 4 0`;
const RING = 'M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z';

const PATHS = {
  shield: 'M8 1.8l5.2 2v4.1c0 3.2-2.2 5.4-5.2 6.3-3-.9-5.2-3.1-5.2-6.3V3.8zM5.6 8.1l1.7 1.7 3.2-3.4',
  check: 'M3.5 8.4l3 3 6-6.4',
  pause: 'M5.8 4v8M10.2 4v8',
  power: 'M8 2v5.5M4.6 4.2a5 5 0 1 0 6.8 0',
  eyeOff: 'M2 8s2.3-4.2 6-4.2S14 8 14 8s-2.3 4.2-6 4.2S2 8 2 8zM8 6.2a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6zM2.5 13.5l11-11',
  list: 'M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01',
  alert: 'M8 2l6.2 11H1.8zM8 6.3v3.2M8 11.6h.01',
  settings: 'M8 5.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  chevron: 'M6 3.5L10.5 8 6 12.5',
  chevronDown: 'M3.5 6L8 10.5 12.5 6',
  back: 'M10 3.5L5.5 8l4.5 4.5',
  ad: 'M2.5 6.2v3.4h2.2l5 3V3.4l-5 2.8zM12.2 5.6a3.2 3.2 0 0 1 0 4.6',
  tracker: `${RING}M8 5.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM8 .6v2.2M8 13.2v2.2M.6 8h2.2M13.2 8h2.2`,
  building: 'M3 14V3.5L9 2v12M9 6h4v8M1.5 14h13M5.5 5.5v.01M5.5 8v.01M5.5 10.5v.01M11 8.5v.01M11 11v.01',
  wrench: 'M13.5 4.5l-2.2 2.2-2-2 2.2-2.2a3.3 3.3 0 0 0-4.3 4.3L2.6 11.4a1.4 1.4 0 0 0 2 2l4.6-4.6a3.3 3.3 0 0 0 4.3-4.3z',
  reload: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5',
  globe: `${RING}M1.8 8h12.4M8 1.8c1.8 1.8 2.6 3.9 2.6 6.2S9.8 12.4 8 14.2C6.2 12.4 5.4 10.3 5.4 8S6.2 3.6 8 1.8z`,
  lock: 'M3.8 7.2h8.4v6.3H3.8zM5.6 7.2v-2a2.4 2.4 0 0 1 4.8 0v2',
  archive: 'M2 3h12v3H2zM3 6v7h10V6M6.5 8.8h3',
  info: `${RING}M8 7.3v4M8 4.9h.01`,
  clock: `${RING}M8 4.5V8l2.5 1.5`,
  popup: 'M2.5 3.5h11v9h-11zM2.5 6h11M9 8.5l2 2M11 8.5l-2 2',
  light: wave(8),
  standard: `${wave(6)}${wave(10.5)}`,
  thorough: `${wave(4)}${wave(8)}${wave(12)}`,
} as const;

export type GlyphName = keyof typeof PATHS;
export const GLYPH_NAMES = Object.keys(PATHS) as readonly GlyphName[];

export interface GlyphProps {
  readonly name: GlyphName;
  readonly size?: number;
  readonly class?: string | undefined;
}

export function Glyph({ name, size = DEFAULT_SIZE, class: className }: GlyphProps): JSX.Element {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
      data-glyph={name}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
