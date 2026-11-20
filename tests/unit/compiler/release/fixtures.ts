/** Small extension zips for the release-tooling tests (P2-01, P2-02). */
import { writeZip, type ZipEntry } from '../../../../compiler/release/zip.js';

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
export const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const RESOURCES = [
  { id: 'ubo', enabled: true, path: 'rulesets/ubo.json' },
  { id: 'ubo-x', enabled: false, path: 'rulesets/ubo-x.json' },
  { id: 'easylist', enabled: true, path: 'rulesets/easylist.json' },
];

export const manifestText = (version: string, extra = ''): string =>
  `{"manifest_version":3,"name":"Glassmere","version":"${version}"${extra},"permissions":["declarativeNetRequest"],"declarative_net_request":{"rule_resources":${JSON.stringify(RESOURCES)}}}`;

export const block = (id: number, host: string): object => ({ id, priority: 10, action: { type: 'block' }, condition: { requestDomains: [host] } });
export const redirect = (id: number, host: string): object =>
  ({ id, priority: 10, action: { type: 'redirect', redirect: { extensionPath: '/surrogates/noop.js' } }, condition: { requestDomains: [host] } });

export const rulesText = (rules: readonly object[]): string => JSON.stringify(rules);

export interface ZipSpec {
  readonly version?: string;
  readonly manifest?: string;
  readonly files?: Readonly<Record<string, string>>;
}

/** Twenty block rules `n1.example` … `n20.example`, ids 1–20: big enough that one more stays under the growth guard. */
export const UBO_RULES: readonly object[] = Array.from({ length: 20 }, (_, i) => block(i + 1, `n${String(i + 1)}.example`));

export const CATALOG = JSON.stringify({ schema: 1, rulesets: {
  ubo: { needsHostAccess: false, maxRules: 100, maxRegex: 1 }, 'ubo-x': { needsHostAccess: true, maxRules: 10, maxRegex: 0 },
  easylist: { needsHostAccess: false, maxRules: 100, maxRegex: 0 } }, packs: {} });

export const BASE_FILES: Readonly<Record<string, string>> = {
  'background.js': 'console.log(1)'.repeat(50),
  'catalog.json': CATALOG,
  'rulesets/ubo.json': rulesText(UBO_RULES),
  'rulesets/ubo-x.json': rulesText([redirect(1, 'cdn.example')]),
  'rulesets/easylist.json': rulesText([block(1, 'banner.example')]),
};

/** A zip like a release build: manifest plus `files` (defaults to `BASE_FILES`). */
export function extensionZip(spec: ZipSpec = {}): Uint8Array {
  const files = spec.files ?? BASE_FILES;
  const entries: ZipEntry[] = [
    { path: 'manifest.json', data: text(spec.manifest ?? manifestText(spec.version ?? '1.0.317.600')) },
    ...Object.entries(files).map(([path, data]) => ({ path, data: text(data) })),
  ];
  return writeZip(entries);
}
