import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

interface PackageRule {
  readonly matchDepTypes?: readonly string[];
  readonly matchPackageNames?: readonly string[];
  readonly groupName?: string;
  readonly automerge?: boolean;
}

interface RenovateConfig {
  readonly minimumReleaseAge: string;
  readonly rangeStrategy: string;
  readonly automerge: boolean;
  readonly packageRules: readonly PackageRule[];
}

const config = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../renovate.json'), 'utf8'),
) as RenovateConfig;

const ruleFor = (predicate: (rule: PackageRule) => boolean): PackageRule | undefined =>
  config.packageRules.find(predicate);

describe('Renovate policy (tooling notes §9)', () => {
  test('waits 7 days after a release and pins exact versions', () => {
    expect(config.minimumReleaseAge).toBe('7 days');
    expect(config.rangeStrategy).toBe('pin');
  });

  test('never auto-merges', () => {
    expect(config.automerge).toBe(false);
    expect(config.packageRules.every((rule) => rule.automerge !== true)).toBe(true);
  });

  test('groups dev dependencies', () => {
    expect(ruleFor((r) => r.matchDepTypes?.includes('devDependencies') ?? false)?.groupName).toBe(
      'dev dependencies',
    );
  });

  test('keeps runtime dependencies ungrouped and WXT in its own PR', () => {
    expect(ruleFor((r) => r.matchDepTypes?.includes('dependencies') ?? false)?.groupName).toBe(
      undefined,
    );
    expect(ruleFor((r) => r.matchPackageNames?.includes('wxt') ?? false)?.groupName).toBe('wxt');
  });
});
