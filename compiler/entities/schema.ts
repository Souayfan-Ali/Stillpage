/**
 * `lists/entities.json` (P1-20, ADR-011): our own host-suffix → company map for attribution buckets.
 * At most 300 companies. Written from public first-party information (each company's own domains);
 * nothing is copied from DuckDuckGo Tracker Radar or Ghostery TrackerDB (CC BY-NC-SA, S-13).
 * Rules: every domain is a valid lower-case hostname, no domain is listed twice, and no listed
 * domain sits under another listed domain (so a host maps to exactly one company).
 */
import { z } from 'zod';
import type { Hostname } from '../../src/core/ids.js';
import { parseHostname } from '../../src/core/hostname/validate.js';
import { parentDomains } from '../../src/core/hostname/walk.js';
import { MAX_COMPANIES } from '../../src/core/limits.js';


const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const domain = z.string().refine((d) => parseHostname(d) === d && d.includes('.'), 'domain: a lower-case hostname with a dot');

const CompanySchema = z.strictObject({
  id: z.string().regex(ID),
  name: z.string().min(1),
  domains: z.array(domain).min(1),
});

/** Every problem with domain ownership: duplicates and domains nested under another listed domain. */
function ownershipErrors(companies: readonly z.infer<typeof CompanySchema>[]): string[] {
  const owner = new Map<string, string>();
  const errors: string[] = [];
  for (const c of companies) {
    for (const d of c.domains) {
      const previous = owner.get(d);
      if (previous !== undefined) errors.push(`domain "${d}" is listed by "${previous}" and "${c.id}"`);
      owner.set(d, c.id);
    }
  }
  for (const [d, id] of owner) {
    const parent = parentDomains(d as Hostname).slice(1).find((p) => owner.has(p));
    if (parent !== undefined) errors.push(`domain "${d}" (${id}) is under "${parent}" (${owner.get(parent) ?? ''})`);
  }
  const ids = companies.map((c) => c.id);
  errors.push(...ids.filter((id, i) => ids.indexOf(id) !== i).map((id) => `duplicate company id "${id}"`));
  return errors;
}

export const EntitiesSchema = z
  .strictObject({
    schema: z.literal(1),
    _comment: z.string().optional(),
    companies: z.array(CompanySchema).max(MAX_COMPANIES),
  })
  .superRefine((v, ctx) => {
    for (const message of ownershipErrors(v.companies)) ctx.addIssue({ code: 'custom', message });
  });

export type Entities = z.infer<typeof EntitiesSchema>;

/** host → company id, by the most specific listed suffix (there is at most one, see the rules above). */
export function entityIndex(entities: Entities): (host: string) => string | undefined {
  const owner = new Map(entities.companies.flatMap((c) => c.domains.map((d) => [d, c.id] as const)));
  return (host) => {
    const h = parseHostname(host);
    if (h === null) return undefined;
    for (const suffix of parentDomains(h)) {
      const id = owner.get(suffix);
      if (id !== undefined) return id;
    }
    return undefined;
  };
}

/** Listed domains that no host of the build falls under (ADR-011: every entry must match a list host). */
export function unusedDomains(entities: Entities, hosts: Iterable<string>): readonly string[] {
  const used = new Set<string>();
  const listed = new Set(entities.companies.flatMap((c) => c.domains));
  for (const host of hosts) {
    const h = parseHostname(host);
    if (h === null) continue;
    for (const suffix of parentDomains(h)) if (listed.has(suffix)) used.add(suffix);
  }
  return [...listed].filter((d) => !used.has(d)).sort();
}
