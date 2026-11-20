import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const WORKFLOW_DIR = path.resolve(import.meta.dirname, '../../../.github/workflows');
const PINNED_USES = /^\s*-?\s*uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}(\s+#\s*v\d+(\.\d+)*)?\s*$/;
const USES_LINE = /^\s*-?\s*uses:/;
const MANIFEST_FRAGMENT = 'dist/compiler/manifest.dnr.json';

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: readFileSync(path.join(WORKFLOW_DIR, name), 'utf8') }));

const text = (name: string): string => workflows.find((w) => w.name === name)?.text ?? '';
/** Workflow text without comment lines (the header explains what the owner changes to go live). */
const code = (name: string): string => text(name).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
/** Jobs of a workflow's code: two-space-indented keys under `jobs:`. */
const jobsOf = (t: string): readonly { name: string; text: string }[] =>
  t.slice(t.search(/^jobs:$/m)).split(/^ {2}(?=[a-z][a-z0-9-]*:$)/m).slice(1).map((j) => ({ name: j.slice(0, j.indexOf(':')), text: j }));
const jobOf = (name: string, job: string): string => jobsOf(code(name)).find((j) => j.name === job)?.text ?? '';

/** Pure policy checks for workflow text (tooling notes §6, security notes §7). */
function unpinnedUses(text: string): readonly string[] {
  return text.split('\n').filter((line) => USES_LINE.test(line) && !PINNED_USES.test(line));
}

describe('GitHub workflow policy', () => {
  test('there is at least one workflow, including ci.yml', () => {
    expect(workflows.map((w) => w.name)).toContain('ci.yml');
  });

  test.each(workflows)('$name pins every action by commit SHA', ({ text }) => {
    expect(unpinnedUses(text)).toEqual([]);
  });

  test.each(workflows)('$name defaults the token to read-only contents', ({ text }) => {
    expect(text).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  test('ci.yml uses no secrets', () => {
    const ci = workflows.find((w) => w.name === 'ci.yml');
    expect(ci?.text).not.toMatch(/secrets\./);
  });

  test('ci.yml runs every gate from P0-05', () => {
    const ci = workflows.find((w) => w.name === 'ci.yml')?.text ?? '';
    const gates = ['typecheck', 'lint', 'knip', 'test', 'build', 'size', 'test:e2e'];
    const steps = gates.filter((gate) => new RegExp(`run: npm (run )?${gate}$`, 'm').test(ci));
    expect(steps).toEqual(gates);
  });

  test('the pin check rejects a tag reference', () => {
    expect(unpinnedUses('      - uses: actions/checkout@v7')).toHaveLength(1);
    expect(unpinnedUses(`      - uses: actions/checkout@${'a'.repeat(40)} # v7.0.1`)).toEqual([]);
  });
});

describe('CI on a cold runner (D-123…D-135)', () => {
  const ROOT = path.resolve(WORKFLOW_DIR, '../..');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const ci = (job: string): string => jobOf('ci.yml', job);
  const at = (t: string, needle: string): number => t.indexOf(needle);

  test('the lint job lints the tracked tree only: it fetches, downloads and builds nothing (D-128)', () => {
    const lint = ci('lint');
    expect(lint).toMatch(/run: npm run prepare:types$/m);
    expect(lint).toMatch(/run: npm run lint$/m);
    for (const banned of ['vendor:fetch', 'lists:', 'download-artifact', 'npm run build', 'playwright install']) expect(lint).not.toContain(banned);
  });

  test('no workflow and no npm script passes an ESLint ignore pattern; the lint script is the plain gate (D-128)', () => {
    for (const w of workflows) expect(w.text).not.toContain('--ignore-pattern');
    expect(Object.values(pkg.scripts).filter((s) => s.includes('--ignore-pattern'))).toEqual([]);
    expect(pkg.scripts['lint']).toBe('eslint --max-warnings=0 .');
  });

  test.each([['verify', 'npm run typecheck'], ['e2e-smoke', 'npm run test:e2e']])('%s needs compiler and unpacks its generated data before %s (D-127)', (job, first) => {
    const t = ci(job);
    expect(t).toMatch(/^ {4}needs: compiler$/m);
    expect(at(t, 'download-artifact')).toBeGreaterThan(-1);
    expect(t).toMatch(/name: generated-public$/m);
    expect(at(t, 'tar -xf')).toBeGreaterThan(at(t, 'download-artifact'));
    expect(at(t, first)).toBeGreaterThan(at(t, 'tar -xf'));
  });

  test('lint left the verify job (D-128)', () => {
    expect(ci('verify')).not.toContain('npm run lint');
  });

  test('the compiler job builds the exact lock in the store shape, checks lists/ is unchanged, then hands public/ and the manifest fragment on (D-124, D-125, D-136)', () => {
    const t = ci('compiler');
    expect(t).toMatch(/run: npm run lists:fetch -- --drop-pending$/m);
    expect(t).toMatch(/run: npm run lists:build -- --check-determinism --drop-pending$/m);
    expect(t).not.toContain('--refresh');
    expect(t).not.toContain('--offline ||');
    expect(t).toContain('test -z "$(git status --porcelain -- lists)"');
    const upload = t.search(/name: generated-public$/m);
    expect(upload).toBeGreaterThan(at(t, 'npm run lists:build'));
    // D-136: the build reads rule_resources from this fragment (wxt.config.ts); a tar without it packages 0 rulesets.
    expect(readFileSync(path.resolve(WORKFLOW_DIR, '../../wxt.config.ts'), 'utf8')).toContain(`'${MANIFEST_FRAGMENT}'`);
    expect(t).toMatch(new RegExp(`tar -cf "\\$RUNNER_TEMP/generated-public\\.tar" public ${MANIFEST_FRAGMENT.replaceAll('.', '\\.')}$`, 'm'));
  });

  test('e2e-smoke installs the two fonts panelFit pins before the suite runs (D-139)', () => {
    const t = ci('e2e-smoke');
    const fonts = at(t, 'apt-get install -y --no-install-recommends fonts-noto-core fonts-dejavu-core');
    expect(fonts).toBeGreaterThan(at(t, 'playwright install --with-deps chromium'));
    expect(at(t, 'npm run test:e2e')).toBeGreaterThan(fonts);
  });

  test('every job that runs the DNR suite fetches the uBOL oracle first (D-131)', () => {
    const jobs = workflows.flatMap((w) => jobsOf(code(w.name)).filter((j) => j.text.includes('npm run test:dnr')).map((j) => ({ ...j, id: `${w.name}:${j.name}` })));
    expect(jobs.map((j) => j.id)).toEqual(expect.arrayContaining(['ci.yml:compiler', 'rulesets.yml:candidate']));
    for (const j of jobs) {
      const fetch = at(j.text, 'npm run oracle:fetch');
      expect(fetch, j.id).toBeGreaterThan(-1);
      expect(fetch, j.id).toBeLessThan(at(j.text, 'npm run test:dnr'));
    }
  });

  test('the uBOL pin of scripts/fetch-ubol.sh is the oracle release of lists/oracle/ubol.json (D-131)', () => {
    const script = readFileSync(path.join(ROOT, 'scripts/fetch-ubol.sh'), 'utf8');
    const oracle = JSON.parse(readFileSync(path.join(ROOT, 'lists/oracle/ubol.json'), 'utf8')) as { ubol: string };
    expect(/^UBOL_VERSION="([^"]+)"$/m.exec(script)?.[1]).toBe(oracle.ubol);
    expect(script).toMatch(/^UBOL_SHA256="[0-9a-f]{64}"$/m);
    expect(script).toMatch(/sha256sum -c/);
    expect(pkg.scripts['oracle:fetch']).toBe('bash scripts/fetch-ubol.sh');
  });

  test('release.yml builds from the tag alone and zips before it measures (D-132)', () => {
    const build = jobOf('release.yml', 'build');
    expect(build).toMatch(/run: npm run lists:fetch -- --drop-pending$/m);
    expect(at(build, 'run: npm run zip')).toBeGreaterThan(-1);
    expect(at(build, 'run: npm run zip')).toBeLessThan(at(build, 'run: npm run size'));
  });

  test('rulesets.yml builds the locked lists before it zips the stand-in base; both builds drop pending packs (D-133)', () => {
    const t = jobOf('rulesets.yml', 'candidate');
    const builds = t.split('\n').filter((l) => /npm run lists:(fetch|build)\b/.test(l));
    expect(builds.length).toBeGreaterThanOrEqual(4);
    for (const l of builds) expect(l).toContain('--drop-pending');
    expect(at(t, 'npm run lists:build')).toBeLessThan(at(t, 'npm run zip'));
    expect(at(t, 'npm run lists:fetch -- --drop-pending')).toBeLessThan(at(t, 'npm run lists:build'));
  });
});

describe('release workflows stay dry runs for now (P2-05…P2-07)', () => {
  const releaseFlows = ['rulesets.yml', 'release.yml', 'verify-store.yml'].filter((n) => workflows.some((w) => w.name === n));

  test.each(releaseFlows)('%s has no schedule, no --live and no secret', (name) => {
    const t = code(name);
    expect(t).not.toMatch(/^\s*schedule:/m);
    expect(t).not.toMatch(/--live\b/);
    expect(t).not.toMatch(/secrets\./);
  });

  test('rulesets.yml gates before it publishes, binds the publish to the verdict, and maps every gate exit code', () => {
    const t = text('rulesets.yml');
    expect(t.indexOf('release -- gate')).toBeGreaterThan(t.indexOf('release -- repack'));
    expect(t.indexOf('compiler/store/uploader/main.ts')).toBeGreaterThan(t.indexOf('release -- gate'));
    expect(t).toMatch(/node compiler\/store\/uploader\/main\.ts --zip "\$zip" --verdict /);
    for (const [code, outcome] of [['0', 'publish'], ['3', 'open-pr'], ['4', 'route-to-full'], ['5', 'skip'], ['\\*', 'abort']]) {
      expect(t).toMatch(new RegExp(`^\\s*${code ?? ''}\\) outcome=${outcome ?? ''} ;;`, 'm'));
    }
  });

  test('publish recomputes the verdict with the dependency-free checker before the upload and never reads the artefact verdict (D-58)', () => {
    const publish = jobOf('rulesets.yml', 'publish');
    const check = publish.indexOf('node compiler/store/candidate/main.ts');
    expect(check).toBeGreaterThan(publish.indexOf('download-artifact'));
    const upload = publish.indexOf('node compiler/store/uploader/main.ts');
    expect(upload).toBeGreaterThan(check);
    expect(publish).toMatch(/--out dist\/publish\/verdict\.json/);
    expect(publish).toMatch(/uploader\/main\.ts --zip "\$zip" --verdict dist\/publish\/verdict\.json/);
    expect(publish).not.toMatch(/candidate\/dist\/release\/verdict\.json/);
    expect(publish.slice(check)).not.toMatch(/candidate\/dist\/release\/\*-chrome\.zip/);
    expect(publish).toMatch(/set -euo pipefail/);
  });

  test('the store-key job runs no npm code: no npm, npx or npm cache; it hands the checked bytes on (D-71)', () => {
    const publish = jobOf('rulesets.yml', 'publish');
    expect(publish).not.toMatch(/\bnpm\b|\bnpx\b|jiti/);
    expect(publish).toMatch(/name: ruleset-checked-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    expect(publish).toMatch(/path: dist\/publish\n/);
  });

  test('every job that can hold a store key runs no npm code, except the known full-release jobs (D-71, go-live task)', () => {
    const KNOWN_FULL_RELEASE_NPM = ['release.yml:draft', 'release.yml:submit'];
    const holders = workflows.flatMap((w) => jobsOf(code(w.name)).filter((j) => /^\s*environment:|--live\b|GLASSMERE_CWS_KEY_FILE/m.test(j.text)).map((j) => ({ ...j, id: `${w.name}:${j.name}` })));
    expect(holders.map((h) => h.id)).toContain('rulesets.yml:publish');
    const withNpm = holders.filter((h) => /\bnpm\b|\bnpx\b|cache: npm/.test(h.text)).map((h) => h.id);
    expect(withNpm).toEqual(KNOWN_FULL_RELEASE_NPM);
    for (const h of holders.filter((x) => x.id.startsWith('rulesets.yml'))) {
      const upload = h.text.indexOf('compiler/store/uploader/main.ts');
      expect(upload === -1 || h.text.indexOf('compiler/store/candidate/main.ts') < upload).toBe(true);
      expect(h.text.indexOf('compiler/store/candidate/main.ts')).toBeGreaterThan(-1);
    }
  });

  test('the keyless state job takes the checked zip and verdict only from the publish job, and derives counts (D-71)', () => {
    const state = jobOf('rulesets.yml', 'state');
    expect(state).toMatch(/needs: \[candidate, publish\]/);
    expect(state).not.toMatch(/^\s*environment:/m);
    expect(state).toMatch(/name: ruleset-checked-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
    expect(state).not.toMatch(/cache: npm/);
    expect(state).toMatch(/release -- state --candidate "\$1"/);
    expect(state).toMatch(/set -- dist\/publish\/\*-chrome\.zip/);
    expect(state).not.toMatch(/--counts|candidate\/dist\/release\/\*-chrome\.zip/);
  });

  test('the candidate job reports pop-up lift drift after the repack, never blocking the run (D-73)', () => {
    const candidate = jobOf('rulesets.yml', 'candidate');
    const drift = candidate.indexOf('release -- lift-drift');
    expect(drift).toBeGreaterThan(candidate.indexOf('release -- repack'));
    expect(drift).toBeLessThan(candidate.indexOf('release -- gate'));
    expect(candidate).toMatch(/lift-drift --base \.cache\/published\/base\.zip --candidate "\$1" --today "\$\(date -u \+%F\)" --out dist\/release\/lift-drift\.json/);
    expect(candidate.slice(candidate.indexOf('Pop-up lift drift'), drift)).toMatch(/set -- dist\/release\/\*-chrome\.zip\n\s*\[ "\$#" -eq 1 \]/);
  });

  test('store workflows share one concurrency group', () => {
    for (const n of ['rulesets.yml', 'release.yml']) expect(text(n)).toMatch(/^concurrency:\n {2}group: store-mutation$/m);
  });

  test('only the publish job may hold the store key: protected environment, main only', () => {
    const t = text('rulesets.yml');
    expect(t).toMatch(/if: needs\.candidate\.outputs\.outcome == 'publish' && github\.ref == 'refs\/heads\/main'/);
    expect(t).not.toMatch(/restore-keys/);
    expect(t.match(/^\s*environment:/gm)).toHaveLength(1);
    expect(t).toMatch(/^ {2}publish:[\s\S]*environment: store-ruleset/m);
  });

  test('release.yml: build → attest → draft → approval → submit; only attest may mint; key jobs check the zip hash', () => {
    const t = code('release.yml');
    const job = (name: string): string => t.split(/^ {2}(?=[a-z-]+:$)/m).find((j) => j.startsWith(`${name}:`)) ?? '';
    expect(job('attest')).toMatch(/attest-build-provenance@[0-9a-f]{40}/);
    expect(job('attest')).toMatch(/id-token: write/);
    expect(job('build') + job('draft') + job('submit')).not.toMatch(/id-token|attestations/);
    expect(job('build')).toMatch(/\^v\(0\|\[1-9\]/);
    expect(job('build')).toMatch(/ref: refs\/tags\//);
    expect(job('build')).not.toMatch(/--offline \|\|/);
    for (const j of ['attest', 'draft', 'submit']) expect(job(j)).toMatch(/sha256sum -c -/);
    for (const j of ['draft', 'submit']) expect(job(j)).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    expect(job('submit')).toMatch(/submit-full --zip /);
    expect(job('build')).toMatch(/sha256sum -c SHA256SUMS/);
    expect(job('draft')).toMatch(/environment: store-full/);
    expect(job('draft')).toMatch(/upload-full/);
    expect(job('submit')).toMatch(/needs: \[build, draft\]/);
    expect(job('draft')).toMatch(/needs: \[build, attest\]/);
    expect(job('submit')).toMatch(/environment: release-approval/);
    expect(job('submit')).toMatch(/submit-full/);
    expect(t).not.toMatch(/publish-ruleset/);
    expect(t).not.toMatch(/run:.*\$\{\{ needs\./);
  });
});

describe('verify-store.yml (P2-07)', () => {
  const t = workflows.find((w) => w.name === 'verify-store.yml')?.text ?? '';
  test('compares with the record, opens an issue on a mismatch, and only that job may write (issues only)', () => {
    expect(t).toMatch(/release -- verify-store --crx/);
    expect(t).toMatch(/gh issue create/);
    expect(t.match(/^\s*issues: write$/gm)).toHaveLength(1);
    expect(t).not.toMatch(/contents: write|id-token/);
    expect(t).toMatch(/OWNER_\*\) echo "::error::item id is a placeholder/);
  });
});
