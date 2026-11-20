/**
 * The "no hardcoded user-visible strings" rule (P2-40, tooling notes §4, UI notes §10). The rule lives in a unit
 * test, not in ESLint: the ESLint config is kept frozen for now.
 *
 * In UI code it flags: JSX text with a letter; a letter-bearing string in a visible attribute (`aria-label`,
 * `title`, `placeholder`, `alt`, `label`, …); and any string or template text that reads as prose (two
 * words, or a capitalised word). In a `*strings.ts` module every letter-bearing string is flagged: those
 * modules only map keys to `t()` calls. Not flagged: module specifiers, type literals, `Error` messages,
 * logger calls, keyboard key names compared with `.key`, and lines marked `i18n-exempt: <reason>`.
 */
import ts from 'typescript';

export interface Finding {
  readonly line: number;
  readonly text: string;
}

/** Attributes whose value is read out or shown (JSX and `setAttribute`/`el(…, attrs)` alike). */
const VISIBLE_ATTRS = new Set(['aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription', 'aria-placeholder', 'title', 'placeholder', 'alt', 'label']);
const LETTER = /\p{L}/u;
const PROSE = /^\p{Lu}\p{Ll}|\p{L}{2,}[  ]+\p{L}{2,}/u;
const EXEMPT_MARK = 'i18n-exempt:';
const LOG_OBJECTS = new Set(['logger', 'log']);
/** Calls and fields that carry internal error text, never shown as copy. */
const SILENT_CALLEES = new Set(['fail']);
const SILENT_PROPS = new Set(['message']);
/** Calls whose string arguments are message keys or code, not copy. */
const KEY_CALLEES = new Set(['t', 'say', 'plural', 'pluralKey', 'getMessage', 'startsWith', 'endsWith', 'includes', 'querySelector', 'querySelectorAll', 'closest', 'matches']);
/** A message key (`panel_saved`): snake_case with at least one underscore. */
const MESSAGE_KEY = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;
const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken]);

function isStringNode(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** Static text of a template (`a ${x} b` → `a b`). */
const templateText = (node: ts.TemplateExpression): string => [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');

function calleeName(call: ts.CallExpression | ts.NewExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return `${ts.isIdentifier(callee.expression) ? callee.expression.text : ''}.${callee.name.text}`;
  return '';
}

/** True for a call whose string arguments never reach the user: errors and the logger. */
function isSilentCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return false;
  const name = calleeName(node);
  const [object = '', method = object] = name.split('.');
  return method.endsWith('Error') || LOG_OBJECTS.has(object) || SILENT_CALLEES.has(name);
}

/** A string compared with something (`kind === 'pack'`, `case 'pack':`, `e.key === 'Escape'`) is a tag, not copy. */
function isComparedTag(node: ts.Node): boolean {
  const parent = node.parent;
  return (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) || ts.isCaseClause(parent);
}

/** The nodes above `node`, nearest first, up to (not including) the source file. */
function* ancestors(node: ts.Node): Generator<ts.Node> {
  for (let n = node.parent; !ts.isSourceFile(n); n = n.parent) yield n;
}

function isStructural(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) || ts.isImportTypeNode(parent.parent)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === node) && KEY_CALLEES.has(calleeName(parent).split('.').at(-1) ?? '')) return true;
  if (isStringNode(node) && MESSAGE_KEY.test(node.text)) return true;
  return isComparedTag(node);
}

function insideSilentCall(node: ts.Node): boolean {
  for (const n of ancestors(node)) {
    if (isSilentCall(n) || ts.isThrowStatement(n)) return true;
    if (ts.isBlock(n)) return false;
  }
  return false;
}

/** The JSX attribute whose value expression holds `node` (`aria-describedby={a ? 'x y' : 'x'}`). */
function jsxAttributeOf(node: ts.Node): string | null {
  for (const n of ancestors(node)) {
    if (ts.isJsxAttribute(n)) return n.name.getText();
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isBlock(n)) return null;
  }
  return null;
}

/** The attribute a string is the value of: JSX `name="…"`, `{ 'aria-label': '…' }` or `setAttribute('title', '…')`. */
function attributeOf(node: ts.Node): string | null {
  const parent = node.parent;
  const jsx = jsxAttributeOf(node);
  if (jsx !== null) return jsx;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) return ts.isStringLiteral(parent.name) || ts.isIdentifier(parent.name) ? parent.name.text : null;
  if (ts.isCallExpression(parent) && calleeName(parent).endsWith('.setAttribute') && parent.arguments[1] === node) {
    const name = parent.arguments[0];
    return name !== undefined && ts.isStringLiteral(name) ? name.text : null;
  }
  return null;
}

function stringFinding(node: ts.Node, text: string, strict: boolean): boolean {
  if (!LETTER.test(text) || isStructural(node) || insideSilentCall(node)) return false;
  const attribute = attributeOf(node);
  if (attribute !== null && VISIBLE_ATTRS.has(attribute)) return true;
  if (jsxAttributeOf(node) !== null || (attribute !== null && SILENT_PROPS.has(attribute))) return false;
  return strict || PROSE.test(text);
}

/** Hardcoded user-visible strings in one TS/TSX source. `strict` for `*strings.ts` modules. */
export function findHardcoded(fileName: string, source: string, strict = false): readonly Finding[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split('\n');
  const findings: Finding[] = [];
  const report = (node: ts.Node, text: string): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart()).line;
    if (!(lines[line] ?? '').includes(EXEMPT_MARK)) findings.push({ line: line + 1, text: text.trim() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && LETTER.test(node.text)) report(node, node.text);
    else if (isStringNode(node) && stringFinding(node, node.text, strict)) report(node, node.text);
    else if (ts.isTemplateExpression(node) && stringFinding(node, templateText(node), strict)) report(node, templateText(node));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

const HTML_VISIBLE_ATTR = /\s(?:aria-label|aria-description|title|alt|placeholder)="([^"]*\p{L}[^"]*)"/gu;

/** Hardcoded text in an extension page's HTML shell: text nodes, `<title>` and visible attributes. */
export function findHardcodedInHtml(source: string): readonly Finding[] {
  const stripped = source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/<(script|style)\b[\s\S]*?<\/\1>/g, (m) => m.replace(/[^\n]/g, ' '));
  const findings: Finding[] = [];
  stripped.split('\n').forEach((line, i) => {
    const texts = [...line.matchAll(/>([^<>]*)</g)].map((m) => m[1] ?? '').filter((t) => LETTER.test(t));
    const attrs = [...line.matchAll(HTML_VISIBLE_ATTR)].map((m) => m[1] ?? '');
    for (const text of [...texts, ...attrs]) findings.push({ line: i + 1, text: text.trim() });
  });
  return findings;
}
