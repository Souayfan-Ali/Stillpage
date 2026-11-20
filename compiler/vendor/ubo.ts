/**
 * uBO's own filter parser, vendored (ADR-005: no dialect translation). Used at build time only, to
 * compile cosmetic selectors into the programs uBO's procedural engine runs and to split scriptlet
 * arguments exactly as uBO does. The four files are hash-checked against the lock before import.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { VendorLock } from './lock.js';
import { VENDOR_DIR, vendorReader } from './node-ports.js';

const PARSER_FILES = ['src/js/static-filtering-parser.js', 'src/js/arglist-parser.js', 'src/js/jsonpath.js', 'src/lib/csstree/css-tree.js'];
/** uBOL's Chromium environment: native `:has()` (S-03). */
const OPTIONS = { nativeCssHas: true };

/** What uBO's selector compiler made of one selector. */
export type CompiledSelector =
  | { readonly kind: 'css'; readonly selector: string }
  | { readonly kind: 'style'; readonly selector: string; readonly declarations: string }
  | { readonly kind: 'procedural'; readonly program: string }
  | { readonly kind: 'invalid' };

export interface UboParser {
  readonly compileSelector: (selector: string) => CompiledSelector;
  /** `[token, ...args]` of a `##+js(…)` filter, `.js` stripped from the token; null when uBO refuses it. */
  readonly scriptletArgs: (filter: string) => readonly string[] | null;
}

interface ExtSelectorCompiler { compile: (raw: string, out: { compiled?: string }) => boolean }
interface AstFilterParser { parse: (raw: string) => void; hasError: () => boolean; isScriptletFilter: () => boolean; getScriptletArgs: () => string[] }
interface ParserModule {
  readonly ExtSelectorCompiler: new (o: object) => ExtSelectorCompiler;
  readonly AstFilterParser: new (o: object) => AstFilterParser;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Turns uBO's compiled text into our shape; a JSON program with a CSS-able `style` action stays declarative. */
export function readCompiled(compiled: string): CompiledSelector {
  if (!compiled.startsWith('{')) return { kind: 'css', selector: compiled };
  let o: unknown;
  try {
    o = JSON.parse(compiled);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isObject(o)) return { kind: 'invalid' };
  const action: unknown = o['action'];
  const selector = o['selector'];
  const declarations = Array.isArray(action) ? (action as unknown[])[1] : undefined;
  const isStyle = o['cssable'] === true && o['tasks'] === undefined && Array.isArray(action) && action[0] === 'style';
  if (isStyle && typeof declarations === 'string' && typeof selector === 'string') return { kind: 'style', selector, declarations };
  return { kind: 'procedural', program: compiled };
}

/** Loads the vendored parser after checking the bytes of every file it imports. */
export async function loadUboParser(lock: VendorLock, dir = VENDOR_DIR): Promise<UboParser> {
  const read = vendorReader(lock, dir);
  // Import the bytes that were hash-checked, from a fresh private directory (no check-then-reload window).
  const copy = await mkdtemp(path.join(tmpdir(), 'glassmere-ubo-'));
  let mod: ParserModule;
  try {
    for (const f of PARSER_FILES) {
      const bytes = await read(f);
      await mkdir(path.dirname(path.join(copy, f)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(copy, f), bytes, { mode: 0o600, flag: 'wx' });
    }
    mod = (await import(pathToFileURL(path.join(copy, PARSER_FILES[0] ?? '')).href)) as ParserModule;
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
  const selectors = new mod.ExtSelectorCompiler(OPTIONS);
  const filters = new mod.AstFilterParser(OPTIONS);
  return {
    compileSelector: (selector) => {
      const out: { compiled?: string } = {};
      return selectors.compile(selector, out) && typeof out.compiled === 'string' ? readCompiled(out.compiled) : { kind: 'invalid' };
    },
    scriptletArgs: (filter) => {
      filters.parse(filter);
      if (filters.hasError() || !filters.isScriptletFilter()) return null;
      return filters.getScriptletArgs();
    },
  };
}
