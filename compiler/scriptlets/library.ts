/**
 * uBO's scriptlet library, read without executing it (P1-29, ADR-005, S-03 method): the vendored
 * `src/js/resources/*.js` files are parsed with TypeScript's parser; every `registerScriptlet(fn, {…})`
 * and `builtinScriptlets.push({…})` gives a name, aliases, world, `requiresTrust` and dependencies, and
 * every top-level function or class declaration gives its source text. Web-accessible JS resources that
 * lists call as scriptlets (`noeval.js`, …) are taken from `redirect-resources.js` and wrapped.
 */
import ts from 'typescript';
import type { ScriptWorld } from '../../src/core/catalog/registrations.js';

export interface ScriptletDef {
  /** Registered name without `.js` (`set-constant`, `noeval`). */
  readonly name: string;
  readonly aliases: readonly string[];
  readonly world: ScriptWorld;
  readonly requiresTrust: boolean;
  /** Function the dispatcher calls. */
  readonly fn: string;
  /** Functions it needs, transitively closed by `closure`. */
  readonly deps: readonly string[];
}

export interface Library {
  readonly scriptlets: ReadonlyMap<string, ScriptletDef>;
  /** Function or class name → source text. */
  readonly functions: ReadonlyMap<string, string>;
}

interface RawReg { readonly obj: ts.ObjectLiteralExpression; readonly fn: string | undefined }

const stripJs = (n: string): string => (n.endsWith('.js') ? n.slice(0, -3) : n);
const prop = (o: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined =>
  o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === key)?.initializer;
const str = (e: ts.Expression | undefined): string | undefined => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);
const items = (e: ts.Expression | undefined): readonly ts.Expression[] => (e && ts.isArrayLiteralExpression(e) ? [...e.elements] : []);

function registrationOf(call: ts.CallExpression): RawReg | undefined {
  const callee = call.expression;
  const [a0, a1] = call.arguments;
  if (ts.isIdentifier(callee) && callee.text === 'registerScriptlet' && a0 && a1 && ts.isObjectLiteralExpression(a1)) {
    return { obj: a1, fn: ts.isIdentifier(a0) ? a0.text : undefined };
  }
  const isPush = ts.isPropertyAccessExpression(callee) && callee.name.text === 'push' && callee.expression.getText() === 'builtinScriptlets';
  if (isPush && a0 && ts.isObjectLiteralExpression(a0)) {
    const fn = prop(a0, 'fn');
    return { obj: a0, fn: fn && ts.isIdentifier(fn) ? fn.text : undefined };
  }
  return undefined;
}

/** Declarations and registrations of one file. */
function scanFile(name: string, text: string): { functions: [string, string][]; regs: RawReg[] } {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions: [string, string][] = [];
  const regs: RawReg[] = [];
  for (const node of sf.statements) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const full = node.getText(sf);
      functions.push([node.name.text, full.replace(/^export\s+(?:default\s+)?/, '')]);
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const r = registrationOf(node.expression);
      if (r) regs.push(r);
    }
  }
  return { functions, regs };
}

function defsOf(regs: readonly RawReg[]): ScriptletDef[] {
  const fnByName = new Map(regs.flatMap((r) => { const n = str(prop(r.obj, 'name')); return n && r.fn ? [[n, r.fn] as const] : []; }));
  return regs.flatMap((r) => {
    const name = str(prop(r.obj, 'name'));
    if (name === undefined || r.fn === undefined) return [];
    const deps = items(prop(r.obj, 'dependencies')).flatMap((d) => {
      const s = str(d);
      if (s !== undefined) return fnByName.get(s) ?? [`<missing ${s}>`];
      return ts.isIdentifier(d) ? [d.text] : [];
    });
    const world = str(prop(r.obj, 'world')) === 'ISOLATED' ? 'ISOLATED' : 'MAIN';
    // Fails closed (security review M3): anything but an absent or literal `false` requires trust, and so
    // does every `trusted-*` name whatever its registration says.
    const trust = prop(r.obj, 'requiresTrust');
    const requiresTrust = (trust !== undefined && trust.kind !== ts.SyntaxKind.FalseKeyword) || stripJs(name).startsWith('trusted-');
    return [{ name: stripJs(name), aliases: items(prop(r.obj, 'aliases')).flatMap((a) => str(a) ?? []).map(stripJs), world, requiresTrust, fn: r.fn, deps }];
  });
}

/** Web-accessible JS resources (`name.js` → file text), each wrapped as one function. */
export interface WarScript { readonly file: string; readonly aliases: readonly string[]; readonly text: string }

const warFn = (file: string): string => `war_${file.replace(/[^A-Za-z0-9]/g, '_')}`;

/** Builds the library from vendored file texts (`path → text`) and the WAR scripts. */
export function readLibrary(files: ReadonlyMap<string, string>, war: readonly WarScript[]): Library {
  const scanned = [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, t]) => scanFile(f, t));
  const functions = new Map(scanned.flatMap((s) => s.functions));
  const defs = defsOf(scanned.flatMap((s) => s.regs));
  const missing = defs.flatMap((d) => [d.fn, ...d.deps]).filter((f) => !functions.has(f));
  if (missing.length > 0) throw new Error(`scriptlet library: functions not found: ${[...new Set(missing)].join(', ')}`);
  for (const w of war) functions.set(warFn(w.file), `function ${warFn(w.file)}() {\n${w.text}\n}`);
  const warDefs: ScriptletDef[] = war.map((w) => ({ name: stripJs(w.file), aliases: w.aliases.map(stripJs), world: 'MAIN', requiresTrust: false, fn: warFn(w.file), deps: [] }));
  return { scriptlets: new Map([...warDefs, ...defs].map((d) => [d.name, d])), functions };
}

/** Name or alias, with or without `.js`, → the registered definition (uBO's resolution). */
export function resolver(lib: Library): (name: string) => ScriptletDef | undefined {
  const index = new Map<string, ScriptletDef>();
  // `*.fn` registrations are helpers (dependencies), never callable from a filter.
  const callable = [...lib.scriptlets.values()].filter((d) => !d.name.endsWith('.fn'));
  for (const d of callable) {
    for (const n of [d.name, ...d.aliases]) {
      const other = index.get(n);
      if (other !== undefined && other !== d) throw new Error(`scriptlet name "${n}" is claimed by "${other.name}" and "${d.name}"`);
      index.set(n, d);
    }
  }
  return (name) => index.get(stripJs(name));
}

/** Functions a set of scriptlets needs, dependencies first, de-duplicated, in a stable order. */
export function closure(lib: Library, defs: readonly ScriptletDef[]): readonly string[] {
  const depsOf = new Map([...lib.scriptlets.values()].map((d) => [d.fn, d.deps]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (fn: string): void => {
    if (seen.has(fn)) return;
    seen.add(fn);
    for (const d of depsOf.get(fn) ?? []) visit(d);
    out.push(fn);
  };
  for (const d of [...defs].sort((a, b) => (a.name < b.name ? -1 : 1))) visit(d.fn);
  return out;
}
