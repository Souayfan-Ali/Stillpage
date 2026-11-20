/**
 * axe-core in jsdom (P1-39/P1-40). jsdom has no layout, so colour contrast is checked on the tokens
 * (tokens.test.ts) and in the panel E2E in real Chromium; every other rule runs here.
 */
import axe from 'axe-core';

const NO_LAYOUT_RULES = { 'color-contrast': { enabled: false }, 'target-size': { enabled: false } };

export async function axeViolations(root: Element): Promise<readonly string[]> {
  const result = await axe.run(root, { rules: NO_LAYOUT_RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
