/** WCAG 2.2 contrast ratio of two `#rrggbb` colours (test helper for the token checks, P1-39). */
const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
/** sRGB → linear threshold and constants from WCAG 2.2 "relative luminance". */
const SRGB_KNEE = 0.04045;
const LUMINANCE_OFFSET = 0.05;

function channel(hex: string): number {
  const c = Number.parseInt(hex, 16) / 255;
  return c <= SRGB_KNEE ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const match = HEX.exec(color);
  if (match === null) throw new Error(`not a #rrggbb colour: ${color}`);
  const [, r = '', g = '', b = ''] = match;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + LUMINANCE_OFFSET) / (lo + LUMINANCE_OFFSET);
}

/** Custom properties per selector of `css` (innermost rule blocks; blocks with the same selector are merged). */
export function tokenBlocks(css: string): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const blocks = new Map<string, Readonly<Record<string, string>>>();
  const blockPattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selector = '', body = ''] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(blockPattern)) {
    const props = Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k = '', v = '']) => [k, v.trim()]));
    const key = selector.trim().replace(/\s+/g, ' ');
    if (Object.keys(props).length > 0) blocks.set(key, { ...blocks.get(key), ...props });
  }
  return blocks;
}
