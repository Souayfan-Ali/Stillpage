/**
 * A small DNR matcher for the host-only rule shapes the coalescing property tests generate
 * (`||host^` / `requestDomains`, initiator domains and their exclusions, resource types). Not a
 * general DNR engine: Chromium's `testMatchOutcome` is the real oracle (P1-45).
 */
import { outranks } from '../../../../compiler/dnr/precedence.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';

export interface Req {
  readonly host: string;
  readonly initiator: string;
  readonly type: string;
}

const under = (host: string, domains: readonly string[] | undefined): boolean =>
  (domains ?? []).some((d) => host === d || host.endsWith(`.${d}`));

function matches(rule: DnrRule, req: Req): boolean {
  const c = rule.condition;
  const hostOk = c.urlFilter !== undefined
    ? under(req.host, [c.urlFilter.replace(/^\|\|/, '').replace(/\^$/, '')])
    : c.requestDomains === undefined || under(req.host, c.requestDomains);
  const typeOk = c.resourceTypes ? (c.resourceTypes as readonly string[]).includes(req.type) : req.type !== 'main_frame';
  return hostOk && typeOk && !under(req.host, c.excludedRequestDomains)
    && (c.initiatorDomains === undefined || under(req.initiator, c.initiatorDomains))
    && !under(req.initiator, c.excludedInitiatorDomains);
}

/** Action and priority of the winning rule, or `none`. */
export function verdict(rules: readonly DnrRule[], req: Req): string {
  const hits = rules.filter((r) => matches(r, req));
  const best = hits.reduce<DnrRule | undefined>((b, r) => (b === undefined || outranks(r, b) ? r : b), undefined);
  return best ? `${best.action.type}@${String(best.priority ?? 1)}` : 'none';
}
