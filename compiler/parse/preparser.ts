/**
 * `!#if` preprocessor (filter-pipeline notes §4), a port of uBO's preparser (gorhill/uBlock
 * `src/js/static-filtering-parser.js`, `utils.preparser`, commit 2bc679d9, GPL-3.0-or-later) so
 * directives evaluate exactly as in uBOL's build. The environment is uBOL's Chromium one (S-02a);
 * getting it wrong silently changes thousands of rules.
 */

/** uBOL's env for the Chromium build (`platform/mv3/make-rulesets.js`). */
export const UBOL_CHROMIUM_ENV: readonly string[] = Object.freeze(['chromium', 'native_css_has', 'mv3', 'ublock', 'ubol']);

/** Token → state, copied from uBO. `false` is a state no environment contains. */
const TOKENS: ReadonlyMap<string, string> = new Map([
  ['ext_ublock', 'ublock'], ['ext_ubol', 'ubol'], ['ext_devbuild', 'devbuild'],
  ['env_brave', 'brave'], ['env_chromium', 'chromium'], ['env_edge', 'edge'],
  ['env_firefox', 'firefox'], ['env_legacy', 'legacy'], ['env_mobile', 'mobile'],
  ['env_mv3', 'mv3'], ['env_safari', 'safari'], ['cap_html_filtering', 'html_filtering'],
  ['cap_ipaddress', 'ipaddress'], ['false', 'false'], ['ext_abp', 'false'],
  ['adguard', 'adguard'], ['adguard_app_android', 'false'], ['adguard_app_cli', 'false'],
  ['adguard_app_ios', 'false'], ['adguard_app_mac', 'false'], ['adguard_app_windows', 'false'],
  ['adguard_ext_android_cb', 'false'], ['adguard_ext_chromium', 'chromium'],
  ['adguard_ext_chromium_mv3', 'mv3'], ['adguard_ext_edge', 'edge'],
  ['adguard_ext_firefox', 'firefox'], ['adguard_ext_opera', 'chromium'],
  ['adguard_ext_safari', 'false'],
]);

/** One surviving line with its 1-based number in the source file. */
interface SourceLine {
  readonly line: number;
  readonly text: string;
}

export interface PreparseResult {
  readonly lines: readonly SourceLine[];
  readonly ifBlocks: number;
  readonly discardedLines: number;
  /** `!#include` directives: not resolved here (pinned lists are already resolved). */
  readonly includes: readonly SourceLine[];
}

/** `undefined` = unknown token (uBO keeps the block); unknown `cap_*` tokens are false. */
function evalToken(raw: string, env: readonly string[]): boolean | undefined {
  const negated = raw.startsWith('!');
  const token = negated ? raw.slice(1) : raw;
  const state = TOKENS.get(token) ?? (token.startsWith('cap_') ? 'false' : undefined);
  if (state === undefined) return undefined;
  return (state === 'false' && negated) || env.includes(state) !== negated;
}

/** Evaluates an `!#if` expression (`a`, `!a`, `a && b`, `(a || !b)`); `undefined` when malformed or unknown. */
export function evalExpression(input: string, env: readonly string[]): boolean | undefined {
  const expr = input.startsWith('(') && input.endsWith(')') ? input.slice(1, -1) : input;
  const parts = Array.from(expr.matchAll(/(?:(?:&&|\|\|)\s+)?\S+/g), (m) => m[0]);
  const [first, ...rest] = parts;
  if (first === undefined || first.startsWith('|') || first.startsWith('&')) return undefined;
  let result = evalToken(first, env);
  for (const part of rest) {
    const [op, token, extra] = part.split(/ +/);
    if (token === undefined || extra !== undefined) return undefined;
    const state = evalToken(token, env);
    if (state === undefined) return undefined;
    if (op === '||') result = result === true || state;
    else if (op === '&&') result = result === true && state;
    else return undefined;
  }
  return result;
}

interface Frame {
  readonly known: boolean;
  readonly discard: boolean;
}

const DIRECTIVE = /^!#(if|else|endif|include)\b(.*)$/;

/** Applies one directive to the block stack; returns the new stack. */
function applyDirective(stack: readonly Frame[], kind: string, arg: string, env: readonly string[]): readonly Frame[] {
  if (kind === 'if') {
    const r = evalExpression(arg.trim(), env);
    return [...stack, { known: r !== undefined, discard: r === false }];
  }
  const top = stack.at(-1);
  if (top === undefined) return stack;
  if (kind === 'else') return [...stack.slice(0, -1), { known: top.known, discard: !top.discard }];
  return stack.slice(0, -1);
}

/** Lines of `text` that survive the preprocessor for `env` (uBO semantics: unknown expressions keep their block). */
export function preparse(text: string, env: readonly string[] = UBOL_CHROMIUM_ENV): PreparseResult {
  const lines: SourceLine[] = [];
  const includes: SourceLine[] = [];
  let stack: readonly Frame[] = [];
  let ifBlocks = 0;
  let discardedLines = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = DIRECTIVE.exec(raw);
    const discarding = stack.some((f) => f.known && f.discard);
    if (m?.[1] === 'include') {
      if (!discarding) includes.push({ line: i + 1, text: raw });
    } else if (m?.[1] !== undefined) {
      if (m[1] === 'if') ifBlocks += 1;
      stack = applyDirective(stack, m[1], m[2] ?? '', env);
    } else if (discarding) {
      discardedLines += 1;
    } else {
      lines.push({ line: i + 1, text: raw });
    }
  });
  return { lines, ifBlocks, discardedLines, includes };
}
