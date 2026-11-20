/**
 * Same-site approximation for the pop-up guard (pop-up notes §7.2): the registrable domain is the last two
 * labels, or three under one of the two-label public suffixes below. No Public Suffix List is bundled
 * (D-34); an unknown suffix (`com.ng`) makes more hosts look same-site, which errs towards allowing,
 * never towards over-blocking. Pure and dependency-free: the sentinel imports it.
 */

/** Common two-label ICANN suffixes (ccSLDs). Private suffixes are left out on purpose (see above). */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set(
  ('co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk com.au net.au org.au edu.au gov.au co.nz org.nz net.nz co.jp ne.jp or.jp ac.jp go.jp ' +
    'co.kr or.kr com.br net.br org.br com.cn net.cn org.cn com.mx com.ar com.tr co.in net.in org.in co.za com.sg com.hk ' +
    'com.tw co.il com.my co.id com.ph com.vn com.ua com.pl co.th com.eg com.sa').split(' '),
);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True for a host that is itself a suffix: one label (`com`) or a listed two-label suffix. */
export function isSuffix(host: string): boolean {
  return !host.includes('.') || TWO_LABEL_SUFFIXES.has(host);
}

/** True for an IPv4 literal. */
export const isIpv4 = (host: string): boolean => IPV4.test(host);

/** Approximate registrable domain of `host`; an IP literal or a suffix is its own site. */
export function siteOf(host: string): string {
  if (isIpv4(host) || isSuffix(host)) return host;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** True when two hosts share their approximate registrable domain. */
export const isSameSite = (a: string, b: string): boolean => siteOf(a) === siteOf(b);
