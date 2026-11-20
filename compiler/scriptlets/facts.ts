/**
 * Scriptlet filters → host facts (P1-29). Arguments are split by uBO's own parser (vendored); the
 * name goes through uBO's resolution (aliases, `.js`, web-accessible JS resources). A `requiresTrust`
 * scriptlet from a list that is not trusted is rejected, as uBO does (S-03). The fact value is
 * `JSON [name, ...args]`: data, never code. `#@#+js()` with no name cancels every scriptlet (`*`).
 */
import type { ScriptWorld } from '../../src/core/catalog/registrations.js';
import { domainsOf, hostFacts, type HostContext } from '../content/cosmetic.js';
import type { Fact } from '../content/facts.js';
import type { LogEntry } from '../normalise/normalise.js';
import type { ReasonCode } from '../normalise/reasons.js';
import type { Entry } from '../parse/parse-list.js';
import type { UboParser } from '../vendor/ubo.js';
import type { ScriptletDef } from './library.js';

/** Value of a `#@#+js()` exception: every scriptlet on that host and below. */
const ALL_SCRIPTLETS = '*';

export interface ScriptletFacts {
  readonly isolated: readonly Fact[];
  readonly main: readonly Fact[];
  readonly log: readonly LogEntry[];
  readonly lostEntities: readonly string[];
}

const none = (source: Entry['source'], reason: ReasonCode, detail?: string): ScriptletFacts =>
  ({ isolated: [], main: [], log: [{ source, reason, ...(detail !== undefined && { detail }) }], lostEntities: [] });

function inWorld(world: ScriptWorld | 'both', facts: readonly Fact[]): Pick<ScriptletFacts, 'isolated' | 'main'> {
  return { isolated: world === 'MAIN' ? [] : facts, main: world === 'ISOLATED' ? [] : facts };
}

/** Facts of one `##+js(…)` / `#@#+js(…)` entry. */
export function scriptletFacts(entry: Entry, ubo: UboParser, resolve: (name: string) => ScriptletDef | undefined, ctx: HostContext): ScriptletFacts {
  const exception = entry.kind === 'scriptlet.exception';
  const args = ubo.scriptletArgs(entry.source.text);
  if (args === null) return none(entry.source, 'scriptlet-invalid');
  const { positive, negative } = domainsOf(entry);
  if (positive.length === 0) return none(entry.source, 'scriptlet-generic');
  const [token, ...rest] = args;
  if (token === undefined || token === '') {
    if (!exception) return none(entry.source, 'scriptlet-invalid');
    const all = hostFacts(entry, positive, 'n', ALL_SCRIPTLETS, ctx);
    return { ...inWorld('both', all.facts), log: all.log, lostEntities: all.lostEntities };
  }
  const def = resolve(token);
  if (def === undefined) return none(entry.source, 'scriptlet-unknown', token);
  if (def.requiresTrust && !entry.trusted && !exception) return none(entry.source, 'scriptlet-untrusted', def.name);
  const value = JSON.stringify([def.name, ...rest]);
  const pos = hostFacts(entry, positive, exception ? 'n' : 'j', value, ctx);
  const neg = exception ? { facts: [], log: [], lostEntities: [] } : hostFacts(entry, negative, 'n', value, ctx);
  return { ...inWorld(def.world, [...pos.facts, ...neg.facts]), log: [...pos.log, ...neg.log], lostEntities: [...pos.lostEntities, ...neg.lostEntities] };
}

/**
 * Replaces the `*` exceptions of `facts` by one exception per invocation of `pool` they cancel (on the
 * host, its parents or its sub-hosts), keeping the wildcard's source. Other facts are returned as is.
 */
export function expandAllExceptions(facts: readonly Fact[], pool: readonly Fact[]): readonly Fact[] {
  const wild = facts.filter((f) => f.kind === 'n' && f.value === ALL_SCRIPTLETS);
  if (wild.length === 0) return facts;
  const related = (a: string, b: string): boolean => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  const expanded = wild.flatMap((w) => pool.filter((f) => f.kind === 'j' && related(f.host, w.host)).map((f) => ({ ...w, value: f.value })));
  return [...facts.filter((f) => !wild.includes(f)), ...expanded];
}
