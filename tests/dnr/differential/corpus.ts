/**
 * The P1-45 differential corpus (PARTIAL for now, testing notes §5, ADR-004 condition 2): ≥ 20,000
 * `(url, type, initiator)` requests from a fixed-seed generator, as S-02c did — derived from uBOL's and
 * our rule conditions, plus benign requests to well-known hosts, with `main_frame` over-sampled.
 * Recording real traffic needs the live web (nightly only) and is owner / nightly work; until then
 * this corpus is the gate's input. Same seed and same rules → the same corpus, byte for byte.
 */
import { createHash } from 'node:crypto';
import { MUST_ALLOW } from '../data/mustAllow.js';
import type { DnrRequest } from '../support/verdict.js';

export const SEED = 20_261_114;

/** Corpus composition (sums to 20,000). */
const COMPOSITION = { ubolRules: 8_000, ourRules: 8_000, benign: 3_000, ourMainFrame: 500, benignMainFrame: 500 } as const;

export interface CorpusRequest extends DnrRequest {
  /** Where the request came from: `ubol-rules`, `our-rules`, `benign`, `our-main_frame`, `benign-main_frame`. */
  readonly source: string;
}

const TYPES = ['script', 'image', 'xmlhttprequest', 'sub_frame', 'stylesheet', 'font', 'media', 'ping', 'websocket', 'other'];
const SITES = [
  'www.news-daily.com',
  'blog.example-site.org',
  'shop.store-front.net',
  'www.cnn.com',
  'www.bbc.co.uk',
  'forum.gamer-hub.io',
  'www.recipes-world.fr',
  'video.streamzone.tv',
];
const PATH_HOSTS = ['ads.adhost-net.com', 'static.cdn-files.com', 'www.publisher-site.com'];
const BENIGN_PATHS = ['js/app', 'img/logo', 'api/v1/data', 'css/main', 'video/clip'];
const BENIGN_EXTS = ['js', 'png', 'json', 'css', 'mp4'];
const MAX_PATH_NUMBER = 100_000;
const UINT32 = 4_294_967_296;
const MAX_ATTEMPTS_PER_REQUEST = 20;

/** mulberry32, the generator S-02c used. */
function generator(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

interface Condition {
  readonly urlFilter?: string;
  readonly regexFilter?: string;
  readonly requestDomains?: readonly string[];
  readonly resourceTypes?: readonly string[];
  readonly initiatorDomains?: readonly string[];
  readonly domainType?: string;
}

type Rng = () => number;

const pick = <T>(rnd: Rng, list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
const registrable = (host: string): string => host.split('.').slice(-2).join('.');

function urlFromFilter(rnd: Rng, filter: string): string {
  const pattern = filter.replace(/\*/g, 'x1').replace(/\^/g, '/').replace(/\|$/, '');
  if (pattern.startsWith('||')) return `https://${pattern.slice(2)}`;
  if (pattern.startsWith('|')) return pattern.slice(1);
  return `https://${pick(rnd, PATH_HOSTS)}/${pattern.replace(/^\/+/, '')}`;
}

function urlFor(rnd: Rng, c: Condition): string {
  if (c.requestDomains !== undefined) return `https://${rnd() < 0.3 ? 'cdn.' : ''}${pick(rnd, c.requestDomains)}/assets/${String(Math.floor(rnd() * MAX_PATH_NUMBER))}.js`;
  if (c.urlFilter !== undefined) return urlFromFilter(rnd, c.urlFilter);
  return `https://www.${pick(rnd, SITES)}/path/${String(Math.floor(rnd() * MAX_PATH_NUMBER))}`;
}

function initiatorFor(rnd: Rng, c: Condition, host: string): string {
  if (c.initiatorDomains !== undefined) return `https://${rnd() < 0.5 ? 'www.' : ''}${pick(rnd, c.initiatorDomains)}`;
  if (c.domainType === 'firstParty') return `https://www.${registrable(host)}`;
  return `https://${pick(rnd, SITES)}`;
}

/** A request the rule should match (best effort), or `null` when no usable URL can be made. */
function requestFor(rnd: Rng, rule: { condition: Condition }, source: string): CorpusRequest | null {
  const c = rule.condition;
  if (c.regexFilter !== undefined) return null;
  const raw = urlFor(rnd, c);
  const withScheme = /^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`;
  if (!URL.canParse(withScheme)) return null;
  const url = new URL(withScheme);
  if (!/^(https?|wss?):$/.test(url.protocol)) return null;
  const type = pick(rnd, c.resourceTypes ?? TYPES);
  const initiator = initiatorFor(rnd, c, url.hostname);
  // `www.` before an IP address is not a valid origin; Chrome refuses such a test request.
  return URL.canParse(initiator) ? { url: url.href, type, initiator, source } : null;
}

function sample(rnd: Rng, rules: readonly { condition: Condition }[], count: number, source: string): CorpusRequest[] {
  const usable = rules.filter((r) => r.condition.regexFilter === undefined);
  if (usable.length === 0) throw new Error(`no non-regex rules to derive ${source} requests from`);
  const out: CorpusRequest[] = [];
  for (let attempts = 0; out.length < count; attempts += 1) {
    if (attempts > count * MAX_ATTEMPTS_PER_REQUEST) throw new Error(`could not derive ${String(count)} ${source} requests`);
    const request = requestFor(rnd, pick(rnd, usable), source);
    if (request !== null) out.push(request);
  }
  return out;
}

function benign(rnd: Rng, count: number): CorpusRequest[] {
  const hosts = [...new Set(MUST_ALLOW.map((c) => new URL(c.url).hostname))].sort();
  return Array.from({ length: count }, (_, i) => {
    const host = pick(rnd, hosts);
    const served = rnd() < 0.5 ? host : `static.${registrable(host)}`;
    const file = `${pick(rnd, BENIGN_PATHS)}${String(i)}.${pick(rnd, BENIGN_EXTS)}`;
    return { url: `https://${served}/${file}`, type: pick(rnd, TYPES), initiator: `https://${rnd() < 0.5 ? host : pick(rnd, SITES)}`, source: 'benign' };
  });
}

type RulesOf = readonly { readonly rules: readonly object[] }[];

const conditions = (sets: RulesOf): { condition: Condition }[] => sets.flatMap((s) => s.rules as { condition: Condition }[]);

/** The corpus for the given rule sets; deterministic for a seed. */
export function buildCorpus(ubol: RulesOf, ours: RulesOf, seed: number = SEED): readonly CorpusRequest[] {
  const rnd = generator(seed);
  const n = COMPOSITION;
  const fromUbol = sample(rnd, conditions(ubol), n.ubolRules, 'ubol-rules');
  const fromOurs = sample(rnd, conditions(ours), n.ourRules, 'our-rules');
  const plain = benign(rnd, n.benign + n.benignMainFrame);
  const ourNav = sample(rnd, conditions(ours), n.ourMainFrame, 'our-main_frame');
  const navigations = [...ourNav, ...plain.slice(0, n.benignMainFrame).map((b) => ({ ...b, source: 'benign-main_frame' }))].map((r) => ({
    ...r,
    type: 'main_frame',
  }));
  return [...fromUbol, ...fromOurs, ...plain.slice(n.benignMainFrame), ...navigations];
}

/** sha256 of the corpus, for the report. */
export function corpusHash(corpus: readonly CorpusRequest[]): string {
  return createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
}
