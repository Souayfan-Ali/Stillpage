/**
 * uBO's `redirect-resources.js` (vendored), read without executing it: the resource names, their
 * aliases and file names under `src/web_accessible_resources/` (P1-29 scriptlet resources, P1-30
 * surrogates).
 */
import ts from 'typescript';

export interface RedirectResource {
  /** File name under `src/web_accessible_resources/` (uBO uses it as the canonical name). */
  readonly name: string;
  readonly aliases: readonly string[];
}

const text = (e: ts.Expression): string | undefined => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined);

function aliasesOf(o: ts.ObjectLiteralExpression): string[] {
  const p = o.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === 'alias');
  if (p === undefined) return [];
  const v = p.initializer;
  return ts.isArrayLiteralExpression(v) ? v.elements.flatMap((e) => text(e) ?? []) : [text(v) ?? ''].filter((a) => a !== '');
}

/** Every `[name, {alias, …}]` entry of the default-exported `Map`. Throws when the shape changed. */
export function readRedirectResources(source: string): readonly RedirectResource[] {
  const sf = ts.createSourceFile('redirect-resources.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const exported = sf.statements.find(ts.isExportAssignment)?.expression;
  const list = exported && ts.isNewExpression(exported) ? exported.arguments?.[0] : undefined;
  if (list === undefined || !ts.isArrayLiteralExpression(list)) throw new Error('redirect-resources.js: no `export default new Map([...])`');
  return list.elements.map((el) => {
    const [k, v] = ts.isArrayLiteralExpression(el) ? el.elements : [];
    const name = k === undefined ? undefined : text(k);
    if (name === undefined || v === undefined || !ts.isObjectLiteralExpression(v)) throw new Error('redirect-resources.js: unexpected entry');
    return { name, aliases: aliasesOf(v) };
  });
}
