/**
 * Pop-up documentation (P2-64, pop-up notes): the limits page, the reviewer note, the permission text and the
 * release checklist describe the opt-in guard, and each says whether this build registers the guard
 * scripts. The marker must follow `SHIPPED.guardScripts` in `src/background/popupInputs.ts`: whoever ships
 * the shim (P2-58) flips the marker and the visible status line together (design review).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

/** Documents that describe the guard and carry its status marker. */
const GUARD_DOCS = ['docs/limits.md', 'docs/reviewer-note.md', 'docs/permissions.md'] as const;
const MARKER = /<!-- guard-scripts: (registered|not-registered) -->/g;
const STATUS_LINE: Readonly<Record<string, string>> = {
  registered: 'Status in this build: guard scripts registered when the user turns the guard on.',
  'not-registered': 'Status in this build: guard scripts not registered.',
};

/** `registered` when the worker ships the guard scripts, from the source of `SHIPPED`. */
function shippedState(): string {
  const match = /guardScripts:\s*(true|false)\s*}/.exec(read('src/background/popupInputs.ts'));
  if (match === null) throw new Error('SHIPPED.guardScripts not found in src/background/popupInputs.ts');
  return match[1] === 'true' ? 'registered' : 'not-registered';
}

describe('pop-up guard status in the documents (P2-64)', () => {
  test.each(GUARD_DOCS)('%s states the guard status of this build', (doc) => {
    const text = read(doc);
    const markers = [...text.matchAll(MARKER)].map((m) => m[1] ?? '');
    expect(markers.length).toBeGreaterThan(0);
    expect(new Set(markers)).toEqual(new Set([shippedState()]));
    expect(text).toContain(STATUS_LINE[shippedState()]);
  });
});

describe('pop-up limits and checks (P2-64)', () => {
  test('the limits page says what Smart cannot catch and what needs access to all sites', () => {
    const text = read('docs/limits.md');
    expect(text).toContain('## Pop-ups: what the guard cannot catch');
    for (const phrase of ['real button or link', 'inside an embedded frame', 'new frame', 'Strict', 'access to all sites', 'Proceed once']) {
      expect(text).toContain(phrase);
    }
  });

  test('the reviewer note explains blocked.html and the MAIN-world shim', () => {
    const text = read('docs/reviewer-note.md');
    expect(text).toContain('`blocked.html`');
    expect(text).toContain('`popup-shim.js`');
    expect(text).toMatch(/off by default/i);
  });

  test('the release checklist has the manual pop-up pass, including the blocked page in a private window', () => {
    const text = read('docs/release-checklist.md');
    expect(text).toContain('## Manual pop-up pass (owner, test accounts)');
    for (const phrase of ['sign-in', 'payment', 'single sign-on', 'private window', 'new tab']) {
      expect(text).toContain(phrase);
    }
  });
});
