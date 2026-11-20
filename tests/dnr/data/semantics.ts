/**
 * Semantics rows (testing notes §5, P1-44): one or more rows per DNR feature the compiler relies on, run
 * against a hand-written ruleset loaded twice — with all-sites access and with none — and per
 * conversion rule, run against filters compiled by the real compiler post-pass. Hosts are on the
 * reserved `.test` TLD, one host per feature so rows cannot interfere.
 *
 * Measured edge cases (Chromium 158, `testMatchOutcome` applies host access like real requests do):
 * without host access a higher `redirect` shadows a lower `block` (the request passes, S-19), so the
 * `-x` rulesets must be off; a higher `modifyHeaders` does **not** shadow a lower `block` (ADR-007;
 * `testMatchOutcome` still reports a lone `modifyHeaders` match without access, Chrome then skips it);
 * at equal priority `allow` beats `block`, and `block` beats `redirect`.
 */
import type { DnrCase, Expectation } from '../support/verdict.js';

type Access = 'all' | 'none';

export interface SemanticCase extends DnrCase {
  /** Which copy of the ruleset answers: with all-sites access or without host access. */
  readonly access: Access;
}

const block = (id: number, priority: number, condition: object): object => ({ id, priority, action: { type: 'block' }, condition });
const allow = (id: number, priority: number, condition: object): object => ({ id, priority, action: { type: 'allow' }, condition });

/** The hand-written feature ruleset (`sem`). */
export const SEMANTIC_RULES: readonly object[] = [
  block(1, 5, { urlFilter: '||eq.test^' }),
  allow(2, 5, { urlFilter: '||eq.test/ok/' }),
  block(3, 6, { urlFilter: '||hp.test^' }),
  allow(4, 5, { urlFilter: '||hp.test^' }),
  block(5, 5, { urlFilter: '||br.test^' }),
  { id: 6, priority: 5, action: { type: 'redirect', redirect: { extensionPath: '/n.js' } }, condition: { urlFilter: '||br.test^' } },
  block(7, 1, { urlFilter: '||rd.test^' }),
  { id: 8, priority: 2, action: { type: 'redirect', redirect: { extensionPath: '/n.js' } }, condition: { urlFilter: '||rd.test^' } },
  block(9, 1, { urlFilter: '||mh.test^' }),
  {
    id: 10,
    priority: 2,
    action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-test', operation: 'set', value: '1' }] },
    condition: { urlFilter: '||mh.test^' },
  },
  {
    id: 11,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-test', operation: 'remove' }] },
    condition: { urlFilter: '||mho.test^' },
  },
  { id: 12, priority: 1, action: { type: 'upgradeScheme' }, condition: { urlFilter: '||up.test^' } },
  { id: 13, priority: 1, action: { type: 'allowAllRequests' }, condition: { urlFilter: '||aar.test^', resourceTypes: ['main_frame'] } },
  block(14, 1, { urlFilter: '||tp.test^', domainType: 'thirdParty' }),
  block(15, 1, { urlFilter: '||fp.test^', domainType: 'firstParty' }),
  block(16, 1, { urlFilter: '||ini.test^', initiatorDomains: ['pub.test'] }),
  block(17, 1, { urlFilter: '||exi.test^', excludedInitiatorDomains: ['safe.test'] }),
  block(18, 1, { requestDomains: ['rq.test'] }),
  block(19, 1, { requestDomains: ['erq.test'], excludedRequestDomains: ['ok.erq.test'] }),
  block(20, 1, { urlFilter: '||mf.test^' }),
  block(21, 1, { urlFilter: '||img.test^', resourceTypes: ['image'] }),
  block(22, 1, { urlFilter: '||ert.test^', excludedResourceTypes: ['script'] }),
  block(23, 1, { urlFilter: '|https://anc.test/start' }),
  block(24, 1, { urlFilter: '||dom.test^' }),
  block(25, 1, { urlFilter: '||sep.test/path^' }),
  block(26, 1, { urlFilter: '||wc.test/a*b.js' }),
  block(27, 1, { urlFilter: '||end.test/x.js|' }),
  block(28, 1, { urlFilter: '||cs.test/Path', isUrlFilterCaseSensitive: true }),
  block(29, 1, { urlFilter: '||ci.test/Path' }),
  block(30, 1, { regexFilter: '^https://re\\.test/ad[0-9]+\\.js$' }),
  block(31, 1, { urlFilter: '||meth.test^', requestMethods: ['post'] }),
  block(32, 1, { urlFilter: '||exm.test^', excludedRequestMethods: ['get'] }),
  block(33, 1, { urlFilter: '||ws.test^', resourceTypes: ['websocket'] }),
  block(34, 1, { urlFilter: '||mfo.test^', resourceTypes: ['main_frame'] }),
  allow(35, 1, { urlFilter: '||mfo.test/ok', resourceTypes: ['main_frame'] }),
];

const OTHER = 'https://www.publisher.test';

/** Row options: `initiator: null` for a navigation typed into the address bar (no initiator). */
interface Extra {
  readonly initiator?: string | null;
  readonly method?: string;
}
const NAV: Extra = { initiator: null };

function request(url: string, type: string, expect: Expectation, because: string, extra: Extra): DnrCase {
  const { initiator = OTHER, method } = extra;
  return { url, type, expect, because, ...(initiator === null ? {} : { initiator }), ...(method === undefined ? {} : { method }) };
}

function row(access: Access, url: string, type: string, expect: Expectation, because: string, extra: Extra = {}): SemanticCase {
  return { access, ...request(url, type, expect, because, extra) };
}

/** Rows per DNR feature (`sem` with all-sites access unless the row says `none`). */
export const FEATURE_ROWS: readonly SemanticCase[] = [
  row('all', 'https://eq.test/ok/a.js', 'script', 'allow', 'equal priority: allow beats block'),
  row('all', 'https://eq.test/a.js', 'script', 'block', 'equal priority: the block alone applies'),
  row('all', 'https://hp.test/a.js', 'script', 'block', 'a higher-priority block beats a lower allow'),
  row('all', 'https://br.test/a.js', 'script', 'block', 'equal priority: block beats redirect'),
  row('all', 'https://rd.test/a.js', 'script', 'redirect', 'a higher redirect beats a lower block with host access'),
  row('none', 'https://rd.test/a.js', 'script', 'none', 'without host access a higher redirect shadows the lower block (S-19): -x must be off'),
  row('none', 'https://eq.test/a.js', 'script', 'block', 'without host access a block still applies'),
  row('none', 'https://eq.test/ok/a.js', 'script', 'allow', 'without host access an allow still applies'),
  row('all', 'https://mh.test/a.js', 'script', 'block', 'a higher modifyHeaders does not stop a lower block'),
  row('none', 'https://mh.test/a.js', 'script', 'block', 'without host access a higher modifyHeaders does not shadow a lower block (ADR-007)'),
  row('all', 'https://mho.test/a.js', 'script', 'headers', 'modifyHeaders alone with host access'),
  row('none', 'https://mho.test/a.js', 'script', 'headers', 'testMatchOutcome reports a modifyHeaders match without host access; Chrome applies the header change only with access (S-10)'),
  row('none', 'https://rd.test/a.png', 'image', 'none', 'without host access the shadowing redirect applies to every type it covers'),
  row('none', 'http://up.test/a.js', 'script', 'upgrade', 'upgradeScheme needs no host access'),
  row('all', 'http://up.test/a.js', 'script', 'upgrade', 'upgradeScheme on http'),
  row('all', 'https://aar.test/', 'main_frame', 'allow', 'allowAllRequests on a main_frame', NAV),
  row('all', 'https://tp.test/a.js', 'script', 'block', 'domainType thirdParty from another site'),
  row('all', 'https://tp.test/a.js', 'script', 'none', 'domainType thirdParty: not from the same site', { initiator: 'https://www.tp.test' }),
  row('all', 'https://cdn.fp.test/a.js', 'script', 'block', 'domainType firstParty from a sibling subdomain', { initiator: 'https://www.fp.test' }),
  row('all', 'https://fp.test/a.js', 'script', 'none', 'domainType firstParty: not from another site'),
  row('all', 'https://ini.test/a.js', 'script', 'block', 'initiatorDomains covers subdomains', { initiator: 'https://news.pub.test' }),
  row('all', 'https://ini.test/a.js', 'script', 'none', 'initiatorDomains: another initiator'),
  row('all', 'https://ini.test/a.js', 'script', 'none', 'initiatorDomains: a label-suffix lookalike', { initiator: 'https://xpub.test' }),
  row('all', 'https://exi.test/a.js', 'script', 'none', 'excludedInitiatorDomains', { initiator: 'https://a.safe.test' }),
  row('all', 'https://exi.test/a.js', 'script', 'block', 'excludedInitiatorDomains: another initiator'),
  row('all', 'https://cdn.rq.test/a.js', 'script', 'block', 'requestDomains covers subdomains'),
  row('all', 'https://notrq.test/a.js', 'script', 'none', 'requestDomains: a label-suffix lookalike'),
  row('all', 'https://rq.test.evil.test/a.js', 'script', 'none', 'requestDomains: the host as a prefix'),
  row('all', 'https://a.erq.test/a.js', 'script', 'block', 'requestDomains with an excluded subdomain: others blocked'),
  row('all', 'https://x.ok.erq.test/a.js', 'script', 'none', 'excludedRequestDomains covers its subdomains'),
  row('all', 'https://mf.test/a.js', 'script', 'block', 'no resourceTypes: subresources match'),
  row('all', 'https://mf.test/', 'main_frame', 'none', 'no resourceTypes: main_frame is excluded by default', NAV),
  row('all', 'https://img.test/a.png', 'image', 'block', 'resourceTypes image'),
  row('all', 'https://img.test/a.js', 'script', 'none', 'resourceTypes image: not a script'),
  row('all', 'https://ert.test/a.js', 'script', 'none', 'excludedResourceTypes script'),
  row('all', 'https://ert.test/a.png', 'image', 'block', 'excludedResourceTypes: other types'),
  row('all', 'https://anc.test/start/x', 'script', 'block', 'left anchor |'),
  row('all', 'https://www.anc.test/start', 'script', 'none', 'left anchor |: another host'),
  row('all', 'https://a.b.dom.test/x', 'script', 'block', 'domain anchor || covers subdomains'),
  row('all', 'https://xdom.test/x', 'script', 'none', 'domain anchor || is label-aligned'),
  row('all', 'https://sep.test/path?x=1', 'script', 'block', 'separator ^ before a query'),
  row('all', 'https://sep.test/path/', 'script', 'block', 'separator ^ before a slash'),
  row('all', 'https://sep.test/pathx', 'script', 'none', 'separator ^ is not a letter'),
  row('all', 'https://sep.test/path', 'script', 'block', 'separator ^ at the end of the address'),
  row('all', 'https://wc.test/a123b.js', 'script', 'block', 'wildcard *'),
  row('all', 'https://wc.test/ac.js', 'script', 'none', 'wildcard * needs both ends'),
  row('all', 'https://end.test/x.js', 'script', 'block', 'right anchor |'),
  row('all', 'https://end.test/x.js?y=1', 'script', 'none', 'right anchor |: the address goes on'),
  row('all', 'https://cs.test/Path', 'script', 'block', 'isUrlFilterCaseSensitive: same case'),
  row('all', 'https://cs.test/path', 'script', 'none', 'isUrlFilterCaseSensitive: other case'),
  row('all', 'https://ci.test/path', 'script', 'block', 'urlFilter is case-insensitive by default'),
  row('all', 'https://re.test/ad12.js', 'script', 'block', 'regexFilter'),
  row('all', 'https://re.test/adx.js', 'script', 'none', 'regexFilter: no match'),
  row('all', 'https://meth.test/a', 'xmlhttprequest', 'block', 'requestMethods post', { method: 'post' }),
  row('all', 'https://meth.test/a', 'xmlhttprequest', 'none', 'requestMethods post: a get', { method: 'get' }),
  row('all', 'https://exm.test/a', 'xmlhttprequest', 'none', 'excludedRequestMethods get', { method: 'get' }),
  row('all', 'https://exm.test/a', 'xmlhttprequest', 'block', 'excludedRequestMethods: a put', { method: 'put' }),
  row('all', 'wss://ws.test/socket', 'websocket', 'block', 'resourceTypes websocket'),
  row('all', 'https://mfo.test/', 'main_frame', 'block', 'a main_frame block applies to navigations', NAV),
  row('all', 'https://mfo.test/ok', 'main_frame', 'allow', 'a main_frame allow at equal priority', NAV),
  row('all', 'https://mfo.test/a.js', 'script', 'none', 'a main_frame-only block leaves subresources alone'),
  row('all', 'https://aar.test/a.js', 'script', 'none', 'a main_frame allowAllRequests rule does not match a subresource request by itself'),
  row('all', 'https://ws.test/a.js', 'script', 'none', 'resourceTypes websocket: not a script'),
];

/** One filter per conversion rule, with rows; compiled by the real compiler into `conv`. */
export const CONVERSIONS: readonly { readonly filters: readonly string[]; readonly rows: readonly DnrCase[] }[] = [
  conv(['||c1.test^'], [r('https://c1.test/a.js', 'script', 'block'), r('https://c1.test/', 'main_frame', 'none', NAV)]),
  conv(['||c2.test^$script'], [r('https://c2.test/a.js', 'script', 'block'), r('https://c2.test/a.png', 'image', 'none')]),
  conv(['||c3.test^$third-party'], [r('https://c3.test/a.js', 'script', 'block'), r('https://c3.test/a.js', 'script', 'none', { initiator: 'https://www.c3.test' })]),
  conv(['||c4.test^$1p'], [r('https://c4.test/a.js', 'script', 'block', { initiator: 'https://www.c4.test' }), r('https://c4.test/a.js', 'script', 'none')]),
  conv(['||c5.test^$domain=pub5.test'], [r('https://c5.test/a.js', 'script', 'block', { initiator: 'https://www.pub5.test' }), r('https://c5.test/a.js', 'script', 'none')]),
  conv(['||c6.test^$domain=~safe6.test'], [r('https://c6.test/a.js', 'script', 'none', { initiator: 'https://safe6.test' }), r('https://c6.test/a.js', 'script', 'block')]),
  conv(['||c7.test^', '@@||c7.test/ok.js'], [r('https://c7.test/ok.js', 'script', 'allow'), r('https://c7.test/bad.js', 'script', 'block')]),
  conv(['||c8.test^$important', '@@||c8.test^'], [r('https://c8.test/a.js', 'script', 'block')]),
  conv(['||c9.test^$document'], [r('https://c9.test/', 'main_frame', 'block', NAV), r('https://c9.test/a.js', 'script', 'none')]),
  conv(['||c10.test^$all'], [r('https://c10.test/', 'main_frame', 'block', NAV), r('https://c10.test/a.js', 'script', 'block')]),
  conv(['||c12.test^$script,redirect=noopjs'], [r('https://c12.test/a.js', 'script', 'redirect'), r('https://c12.test/a.png', 'image', 'none')]),
  conv(['||c13.test^$image,removeparam=utm_source'], [r('https://c13.test/p.gif?utm_source=x&id=1', 'image', 'redirect'), r('https://c13.test/p.gif?id=1', 'image', 'none')]),
  conv(["||c14.test^$csp=script-src 'none'"], [r('https://c14.test/', 'main_frame', 'headers', NAV)]),
  conv(['||c15.test^$xhr'], [r('https://c15.test/api', 'xmlhttprequest', 'block'), r('https://c15.test/a.js', 'script', 'none')]),
  conv(['||c16.test^$ping'], [r('https://c16.test/p', 'ping', 'block')]),
  conv(['||c17.test^$media'], [r('https://c17.test/v.mp4', 'media', 'block')]),
  conv(['||c18.test^$websocket'], [r('wss://c18.test/s', 'websocket', 'block')]),
  conv(['||c19.test^$subdocument'], [r('https://c19.test/f.html', 'sub_frame', 'block'), r('https://c19.test/a.js', 'script', 'none')]),
  conv(['||c20.test^$css'], [r('https://c20.test/a.css', 'stylesheet', 'block')]),
  conv(['||c21.test^$font'], [r('https://c21.test/a.woff2', 'font', 'block')]),
  conv(['||c22.test^$object'], [r('https://c22.test/a.swf', 'object', 'block')]),
  conv(['||c23.test^$other'], [r('https://c23.test/a', 'other', 'block')]),
  conv(['/c24-banner/*'], [r('https://any-host.test/c24-banner/x.png', 'image', 'block')]),
  conv(['/c25ad[0-9]+\\.js/'], [r('https://any-host.test/c25ad42.js', 'script', 'block'), r('https://any-host.test/c25adx.js', 'script', 'none')]),
  conv(['||c26.test^$method=post'], [r('https://c26.test/a', 'xmlhttprequest', 'block', { method: 'post' }), r('https://c26.test/a', 'xmlhttprequest', 'none', { method: 'get' })]),
  conv(['||c27.test^$from=pub27.test'], [r('https://c27.test/a.js', 'script', 'block', { initiator: 'https://pub27.test' }), r('https://c27.test/a.js', 'script', 'none')]),
  conv(['||c29.test^', '||c29.test^$badfilter'], [r('https://c29.test/a.js', 'script', 'none')]),
  conv(['c30.test'], [r('https://c30.test/a.js', 'script', 'block'), r('https://xc30.test/a.js', 'script', 'none')]),
  conv(['||c31.test/Ad.js$match-case'], [r('https://c31.test/Ad.js', 'script', 'block'), r('https://c31.test/ad.js', 'script', 'none')]),
  conv(['||c32.test^$script,redirect-rule=noopjs'], [r('https://c32.test/a.js', 'script', 'none')]),
  conv(['@@||c35.test^$document'], [r('https://c35.test/', 'main_frame', 'allow', NAV)]),
  conv(['||c36.test^$image,domain=pub36.test|pub36b.test'], [
    r('https://c36.test/a.png', 'image', 'block', { initiator: 'https://pub36b.test' }),
    r('https://c36.test/a.png', 'image', 'none', { initiator: 'https://pub36c.test' }),
  ]),
  conv(['||c37.test^$~script'], [r('https://c37.test/a.js', 'script', 'none'), r('https://c37.test/a.png', 'image', 'block')]),
  conv(['||c38.test^$~third-party'], [r('https://c38.test/a.js', 'script', 'none'), r('https://c38.test/a.js', 'script', 'block', { initiator: 'https://c38.test' })]),
  conv(['||c39.test^', '@@||c39.test^$script,domain=ok39.test'], [
    r('https://c39.test/a.js', 'script', 'allow', { initiator: 'https://ok39.test' }),
    r('https://c39.test/a.js', 'script', 'block'),
    r('https://c39.test/a.png', 'image', 'block', { initiator: 'https://ok39.test' }),
  ]),
];

function r(url: string, type: string, expect: Expectation, extra: Extra = {}): DnrCase {
  return request(url, type, expect, '', extra);
}

function conv(filters: readonly string[], rows: readonly DnrCase[]): { filters: readonly string[]; rows: readonly DnrCase[] } {
  return { filters, rows: rows.map((x) => ({ ...x, because: `conversion of ${filters.join(' + ')}` })) };
}
