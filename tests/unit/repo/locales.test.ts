/**
 * The message catalogs (P2-40, UI notes §10, Q-13): only reviewed locales ship (English in v1.0), every
 * message is well formed for Chrome, every key the code asks for exists with the right number of
 * substitutions, no key is dead, the product name is never written into a message, and the manifest
 * takes its description (the store summary) and command name from the catalog.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { PRODUCT_NAME } from '../../../src/core/brand.js';
import { createManifest } from '../../../src/core/manifest.js';
import { englishCatalog, type CatalogEntry } from '../../helpers/chromeI18n.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const catalog = englishCatalog();
const KEY = /^[a-z][a-z0-9_]*$/;
/** Calls that take a literal message key first and its substitutions after (`src/ui/i18n.ts`, the in-page notice's `say`). */
const LOOKUPS = new Set(['t', 'getMessage', 'say']);
/** `plural(n, one, other)`: both keys take exactly the count. `pluralKey` only picks a key: its keys must exist. */
const PLURALS = new Map([['plural', 1], ['pluralKey', null]]);

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : [],
  );
}

const placeholderCount = (entry: CatalogEntry): number => Object.keys(entry.placeholders ?? {}).length;

interface Use {
  readonly where: string;
  readonly key: string;
  /** Substitutions passed, or `null` when the count is not checked (spread arguments). */
  readonly args: number | null;
}

function callName(call: ts.CallExpression): string {
  const e = call.expression;
  return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '';
}

function usesIn(file: string): readonly Use[] {
  const source = ts.createSourceFile(file, readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const uses: Use[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      const where = `${file}:${String(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`;
      const literal = (arg: ts.Expression | undefined): string | null => (arg !== undefined && ts.isStringLiteral(arg) ? arg.text : null);
      const first = literal(node.arguments[0]);
      if (LOOKUPS.has(name) && first !== null && !first.startsWith('@@')) {
        const spread = node.arguments.some((a) => ts.isSpreadElement(a) || ts.isArrayLiteralExpression(a));
        uses.push({ where, key: first, args: spread ? null : node.arguments.length - 1 });
      }
      if (PLURALS.has(name)) for (const arg of node.arguments.slice(1, 3)) {
        const key = literal(arg);
        if (key !== null) uses.push({ where, key, args: PLURALS.get(name) ?? null });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

const allSource = (): string => sourceFiles('src').map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

describe('_locales (P2-40, Q-13)', () => {
  test('only English ships: pseudo-locales and unreviewed translations never enter _locales', () => {
    expect(readdirSync(path.join(ROOT, '_locales'))).toEqual(['en']);
  });

  test('every message is well formed for Chrome', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      expect(key, key).toMatch(KEY);
      expect(entry.message.length, key).toBeGreaterThan(0);
      const names = Object.keys(entry.placeholders ?? {});
      expect(names.map((n) => entry.placeholders?.[n]?.content), key).toEqual(names.map((_n, i) => `$${String(i + 1)}`));
      const referenced = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => (m[1] ?? '').toLowerCase());
      expect(new Set(referenced), key).toEqual(new Set(names));
      expect(entry.message.replace(/\$[A-Za-z0-9_]+\$|\$\$/g, ''), `${key}: a lone $ must be written $$`).not.toContain('$');
    }
  });

  test('the catalog names its own language and direction (pages set lang and dir from it)', () => {
    expect(catalog['meta_lang']?.message).toBe('en-GB');
    expect(catalog['meta_dir']?.message).toBe('ltr');
  });

  test('no message writes the product name: it is passed in from src/core/brand.ts', () => {
    expect(Object.keys(catalog).filter((k) => catalog[k]?.message.includes(PRODUCT_NAME))).toEqual([]);
  });

  test('every key the code asks for exists, with as many substitutions as the message has', () => {
    const problems = sourceFiles('src').flatMap(usesIn).flatMap((use) => {
      const entry = catalog[use.key];
      if (entry === undefined) return [`${use.where}: no message ${use.key}`];
      return use.args !== null && use.args !== placeholderCount(entry) ? [`${use.where}: ${use.key} takes ${String(placeholderCount(entry))}, given ${String(use.args)}`] : [];
    });
    expect(problems).toEqual([]);
  });

  test('no dead message: every key appears in the source', () => {
    const source = allSource();
    const dead = Object.keys(catalog).filter((key) => !source.includes(`'${key}'`) && !source.includes(`__MSG_${key}__`));
    expect(dead).toEqual([]);
  });
});

describe('the manifest reads the catalog (P2-40, P2-50 follow-up 1)', () => {
  const manifest = createManifest();

  test('default locale, description and the shortcut name come from _locales', () => {
    expect(manifest.default_locale).toBe('en');
    expect(manifest.description).toBe('__MSG_ext_description__');
    expect(manifest.commands['hide-element'].description).toBe('__MSG_command_hide_element__');
  });

  test('the description is the store summary', () => {
    const listing = readFileSync(path.join(ROOT, 'store/listing.md'), 'utf8');
    const summary = listing.split('\n').find((l) => l.startsWith('**Summary:** '))?.slice('**Summary:** '.length).trim();
    expect(catalog['ext_description']?.message).toBe(summary);
  });
});

describe('entry names (D-103…D-106)', () => {
  const menu = catalog['menu_hide_element']?.message ?? '';
  const DOCS = ['docs/permissions.md', 'docs/privacy-policy.md', 'store/listing.md'] as const;
  const readDoc = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

  test('the shortcut, the menu entry and the first-run text name the two ways in', () => {
    expect(catalog['command_hide_element']?.message).toBe('Hide something on this page');
    expect(menu).toBe('Hide this…');
    expect(catalog['onboarding_hide_text']?.message).toBe(`Right-click what you want gone and choose "${menu}", or open the toolbar panel and choose "Hide something".`);
  });

  test('every message and document quoting the menu entry quotes it as shipped', () => {
    for (const key of ['perm_active_tab_why', 'perm_context_menus_why']) expect(catalog[key]?.message, key).toContain(`"${menu}"`);
    for (const file of DOCS) {
      expect(readDoc(file), file).toContain(`"${menu}"`);
      expect(readDoc(file), file).not.toContain('Hide this element…');
    }
  });

  test('the hidden list is "Hidden items" everywhere: no "things you hid", in any case, in a message or a document', () => {
    expect(Object.keys(catalog).filter((k) => /things you hid/i.test(catalog[k]?.message ?? ''))).toEqual([]);
    for (const file of DOCS) expect(readDoc(file), file).not.toMatch(/things you hid/i);
  });

  test("D-116: the policy names the panel's hidden list by its shipped entry", () => {
    const panelList = (catalog['panel_hidden_open']?.message ?? '').replace(' ($COUNT$)', '');
    expect(panelList).toBe('What you hid on this site');
    const policy = readDoc('docs/privacy-policy.md');
    expect(policy).toContain(`"${panelList}"`);
    expect(policy).toContain(`"${catalog['dash_section_hidden']?.message ?? ''}"`);
  });

  test('show_manage is gone; picker_hint and picker_fewer exist', () => {
    expect(catalog['show_manage']).toBeUndefined();
    expect(catalog['picker_hint']?.message).toBe('Click what you want to hide. Esc cancels.');
    expect(catalog['picker_fewer']?.message).toBe('fewer');
    // D-122: the slider's keys say what they hold.
    for (const key of ['picker_how_much', 'picker_narrower', 'picker_wider']) expect(catalog[key], key).toBeUndefined();
    expect(catalog['picker_similar']?.message).toBe('Similar ones too?');
    expect(catalog['picker_only_this']?.message).toBe('only this');
    expect(catalog['picker_more']?.message).toBe('more like it');
  });
});
