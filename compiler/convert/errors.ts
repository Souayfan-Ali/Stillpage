/**
 * Converter errors → reason codes. A message no pattern recognises fails the build (filter-pipeline notes §4:
 * an unknown reason is an error, never a silent loss).
 */
import { assertReason, type ReasonCode } from '../normalise/reasons.js';

interface ConverterError {
  readonly name?: string;
  readonly message: string;
}

const BY_MESSAGE: readonly (readonly [RegExp, ReasonCode])[] = [
  [/allowlist rule with \$csp modifier|\$csp exception is not compatible/i, 'csp-allow-unresolved'],
  [/\$header is not compatible with \$method/, 'header-with-method'],
  [/Unknown modifier: \d/, 'converter-misparse'],
  // A regex filter whose character class contains a space (`[^&=? ]`) is taken for a hosts line.
  [/Rule has spaces, seems to be a host rule/, 'converter-misparse'],
  [/Unknown modifier|unsupported|not supported|not compatible/i, 'unsupported-modifier'],
];

const BY_NAME: Readonly<Record<string, ReasonCode>> = {
  EmptyDomainsError: 'empty-domains',
  EmptyResourcesError: 'empty-resource-types',
  InvalidDeclarativeRuleError: 'invalid-declarative-rule',
  UnsupportedModifierError: 'unsupported-modifier',
};

/** The reason code for a converter error; throws for one we have never classified. */
export function reasonOfConverterError(e: ConverterError): ReasonCode {
  const byMessage = BY_MESSAGE.find(([re]) => re.test(e.message))?.[1];
  if (byMessage) return byMessage;
  const byName = e.name === undefined ? undefined : BY_NAME[e.name];
  return assertReason(byName ?? `converter:${e.name ?? 'Error'}:${e.message}`);
}
