/**
 * Applies a plan in the order of architecture notes §5.1 (S-17, S-19):
 * (1) when `<all_urls>` is not granted, disable `-x` rulesets and remove host-access rules first;
 * (2) registrations: scriptlets, then the pop-up guard, then cosmetic shards — one call per group;
 *     a rejected registration call is narrowed down with non-persistent probes, the bad
 *     registration dropped and logged, the rest registered in one call (D-19, S-04). One call per
 *     shard was measured too slow in Chrome (≈ 140 ms per call and growing, P1-14; 9–19 s, P1-51);
 * (3) enabled rulesets; (4) individually disabled static rule ids; (5) dynamic, then session rules,
 *     one batched call each.
 * Every step after a failure still runs; failures are collected and the next reconcile repairs them.
 *
 * Exception (D-25, P1-34 measurement): a run with no gate work, no ruleset and no static-rule change —
 * a site-level change — applies (5) before (2). Re-persisting registrations costs ≈ 3.3 s at full
 * scale whatever the size of the change, and rules first is the safe direction both ways (Off
 * un-breaks the site at once; back on blocks at once). `onRulesApplied` lets the panel answer then.
 */
import type { Catalog } from '../core/catalog/types.js';
import type { RulesetId } from '../core/ids.js';
import { own } from '../core/record.js';
import type { Plan, RuleUpdate } from '../core/reconcile/plan.js';
import type { DnrRule, ScriptRegistration } from '../core/reconcile/types.js';
import type { DisabledRules, Ports } from '../platform/ports.js';

export interface ApplyInput {
  readonly plan: Plan;
  readonly catalog: Catalog;
  readonly hasAllSitesAccess: boolean;
  /** Host-access rules currently installed (dynamic and session), removed first by the gate. */
  readonly hostAccessRuleIds: { readonly dynamic: readonly number[]; readonly session: readonly number[] };
  readonly staticRules: readonly StaticRulesChange[];
  /** Called once the scriptlet (MAIN) registrations are in, for the D-19 milestone. */
  readonly onScriptletsRegistered?: () => void;
  /** Called for each registration Chrome refused and the run dropped (logged; a warning). */
  readonly onDropped?: (detail: string) => void;
  /** Called once the dynamic and session rules are in without error (D-25: before registrations when it may). */
  readonly onRulesApplied?: () => void;
}

export interface StaticRulesChange {
  readonly rulesetId: RulesetId;
  readonly disableRuleIds: readonly number[];
  readonly enableRuleIds: readonly number[];
}

/** A step resolves with the error messages of its failed calls. */
type Step = () => Promise<readonly string[]>;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One call; its failure becomes an error message. */
function call(fn: () => Promise<void>): Step {
  return async () => {
    try {
      await fn();
      return [];
    } catch (error) {
      return [message(error)];
    }
  };
}

interface Rejected {
  readonly id: string;
  readonly error: string;
}

/** A probe that registered but could not be removed again: stop, report it as a call failure. */
class ProbeCleanupError extends Error {}

/** Registers `batch` non-persistently and removes it again. Rejects only when Chrome refused it. */
async function probe(batch: readonly ScriptRegistration[], ports: Ports): Promise<void> {
  await ports.scripting.registerContentScripts(batch.map((s) => ({ ...s, persistAcrossSessions: false })));
  try {
    await ports.scripting.unregisterContentScripts(batch.map((s) => s.id));
  } catch (error) {
    throw new ProbeCleanupError(`probe cleanup failed: ${message(error)}`);
  }
}

/** Splits `items` until each rejected one is alone. */
async function isolateRejected(items: readonly ScriptRegistration[], ports: Ports): Promise<readonly Rejected[]> {
  try {
    await probe(items, ports);
    return [];
  } catch (error) {
    if (error instanceof ProbeCleanupError) throw error;
    const [only] = items;
    if (items.length === 1 && only !== undefined) return [{ id: only.id, error: message(error) }];
    const middle = Math.ceil(items.length / 2);
    return [...(await isolateRejected(items.slice(0, middle), ports)), ...(await isolateRejected(items.slice(middle), ports))];
  }
}

/** What one registration group produced: call failures (the run failed) and dropped registrations. */
interface GroupResult {
  readonly errors: readonly string[];
  readonly dropped: readonly string[];
}

/**
 * Registers one group in one persistent call (D-19). On rejection the bad registrations are found
 * with non-persistent probes (≈ 100 ms each at full scale instead of ≈ 2 s for a persistent call,
 * P1-14), dropped and logged, and the rest goes in one persistent call. A dropped registration is a
 * warning, not a failure: it would be dropped again on every run, so it must not keep the run failed.
 */
async function registerGroup(group: readonly ScriptRegistration[], ports: Ports): Promise<GroupResult> {
  try {
    await ports.scripting.registerContentScripts(group);
    return { errors: [], dropped: [] };
  } catch (first) {
    let rejected: readonly Rejected[];
    try {
      rejected = await isolateRejected(group, ports);
    } catch (error) {
      return { errors: [message(error)], dropped: [] };
    }
    // No probe rejected: a transient failure; the retry below decides, the first error is kept here.
    if (rejected.length === 0) ports.log.warn('group registration failed, no registration rejected alone', first);
    rejected.forEach((r) => {
      ports.log.error(`registration ${r.id} dropped`, r.error);
    });
    const rest = group.filter((s) => !rejected.some((r) => r.id === s.id));
    const dropped = rejected.map((r) => `${r.id}: ${r.error}`);
    const errors = rest.length === 0 ? [] : await call(() => ports.scripting.registerContentScripts(rest))();
    return { errors, dropped };
  }
}

/** Registrations grouped by rank, in rank order. */
function groups(list: readonly ScriptRegistration[]): readonly (readonly ScriptRegistration[])[] {
  const sorted = [...list].sort(byRank);
  const ranks = [...new Set(sorted.map((s) => registrationRank(s.id)))];
  return ranks.map((rank) => sorted.filter((s) => registrationRank(s.id) === rank));
}

/** Registration order within step (2): scriptlets, guard, everything else (cosmetic shards). */
function registrationRank(id: string): number {
  if (id.startsWith('main:')) return 0;
  return id.startsWith('popup-') ? 1 : 2;
}

const byRank = (a: ScriptRegistration, b: ScriptRegistration): number =>
  registrationRank(a.id) - registrationRank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const isEmptyUpdate = (u: RuleUpdate): boolean => u.removeRuleIds.length === 0 && u.addRules.length === 0;

function without(update: RuleUpdate, ids: readonly number[]): RuleUpdate {
  return { removeRuleIds: update.removeRuleIds.filter((id) => !ids.includes(id)), addRules: update.addRules };
}

interface Gated {
  readonly rulesets: readonly RulesetId[];
  readonly dynamic: readonly number[];
  readonly session: readonly number[];
}

/** What the gate removes first: nothing while `<all_urls>` is granted. */
function gatedParts(input: ApplyInput): Gated {
  if (input.hasAllSitesAccess) return { rulesets: [], dynamic: [], session: [] };
  const rulesets = input.plan.rulesets.disable.filter((id) => own(input.catalog.rulesets, id)?.needsHostAccess !== false);
  return { rulesets, ...input.hostAccessRuleIds };
}

function gateSteps(gated: Gated, ports: Ports): Step[] {
  const { rulesets, dynamic, session } = gated;
  return [
    ...(rulesets.length > 0 ? [call(() => ports.dnr.updateEnabledRulesets({ enable: [], disable: rulesets }))] : []),
    ...(dynamic.length > 0 ? [call(() => ports.dnr.updateDynamicRules({ removeRuleIds: dynamic, addRules: [] }))] : []),
    ...(session.length > 0 ? [call(() => ports.dnr.updateSessionRules({ removeRuleIds: session, addRules: [] }))] : []),
  ];
}

function scriptSteps(input: ApplyInput, ports: Ports): Step[] {
  const { register, update, unregister } = input.plan.scripts;
  const registerStep = (group: readonly ScriptRegistration[]): Step => async () => {
    const { errors, dropped } = await registerGroup(group, ports);
    dropped.forEach((d) => input.onDropped?.(d));
    if (errors.length === 0 && group.some((s) => registrationRank(s.id) === 0)) input.onScriptletsRegistered?.();
    return errors;
  };
  return [
    ...(unregister.length > 0 ? [call(() => ports.scripting.unregisterContentScripts(unregister))] : []),
    ...groups(update).map((group) => call(() => ports.scripting.updateContentScripts(group))),
    ...groups(register).map(registerStep),
  ];
}

function rulesetSteps(plan: Plan, gated: Gated, ports: Ports): Step[] {
  const { enable } = plan.rulesets;
  const disable = plan.rulesets.disable.filter((id) => !gated.rulesets.includes(id));
  return enable.length > 0 || disable.length > 0 ? [call(() => ports.dnr.updateEnabledRulesets({ enable, disable }))] : [];
}

function ruleSteps(input: ApplyInput, gated: Gated, ports: Ports): Step[] {
  const dynamic = without(input.plan.dynamicRules, gated.dynamic);
  const session = without(input.plan.sessionRules, gated.session);
  return [
    ...input.staticRules.map((change) => call(() => ports.dnr.updateStaticRules(change))),
    ...(isEmptyUpdate(dynamic) ? [] : [call(() => ports.dnr.updateDynamicRules(dynamic))]),
    ...(isEmptyUpdate(session) ? [] : [call(() => ports.dnr.updateSessionRules(session))]),
  ];
}

/** D-25: nothing to gate, no ruleset and no static-rule change — rules may go before registrations. */
function rulesMayLead(input: ApplyInput, gated: Gated): boolean {
  const { plan } = input;
  const noGate = gated.rulesets.length === 0 && gated.dynamic.length === 0 && gated.session.length === 0;
  return noGate && plan.rulesets.enable.length === 0 && plan.rulesets.disable.length === 0 && input.staticRules.length === 0;
}

async function runSteps(steps: readonly Step[]): Promise<string[]> {
  const errors: string[] = [];
  for (const step of steps) errors.push(...(await step()));
  return errors;
}

/** Runs every step in order; returns the error messages of the steps that failed. */
export async function applyInOrder(input: ApplyInput, ports: Ports): Promise<readonly string[]> {
  const gated = gatedParts(input);
  const rules = ruleSteps(input, gated, ports);
  if (rulesMayLead(input, gated)) {
    const ruleErrors = await runSteps(rules);
    if (ruleErrors.length === 0) input.onRulesApplied?.();
    return [...ruleErrors, ...(await runSteps(scriptSteps(input, ports)))];
  }
  const errors = await runSteps([...gateSteps(gated, ports), ...scriptSteps(input, ports), ...rulesetSteps(input.plan, gated, ports)]);
  const ruleErrors = await runSteps(rules);
  if (ruleErrors.length === 0) input.onRulesApplied?.();
  return [...errors, ...ruleErrors];
}

/** Host-access rules among `rules` (the gate removes them first when access is gone). */
export function hostAccessIds(rules: readonly DnrRule[]): readonly number[] {
  return rules.filter((r) => r.action.type === 'redirect' || r.action.type === 'modifyHeaders').map((r) => r.id);
}

/** Static-rule changes from the desired disabled ids and the ids Chrome reports now. */
export function staticRuleChanges(desired: readonly DisabledRules[], actual: readonly DisabledRules[]): readonly StaticRulesChange[] {
  return desired
    .map((want) => {
      const have = actual.find((a) => a.rulesetId === want.rulesetId)?.ruleIds ?? [];
      return {
        rulesetId: want.rulesetId,
        disableRuleIds: want.ruleIds.filter((id) => !have.includes(id)),
        enableRuleIds: have.filter((id) => !want.ruleIds.includes(id)),
      };
    })
    .filter((c) => c.disableRuleIds.length > 0 || c.enableRuleIds.length > 0);
}
