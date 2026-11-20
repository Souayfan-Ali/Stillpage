import { describe, expect, test } from 'vitest';
import { buildReport, issueUrl, MAX_ISSUE_URL_BYTES, MAX_REPORT_CHARS, reportTitle, type ReportInput } from '../../../../src/core/report/report.js';
import { ISSUE_TRACKER_URL, trackerOf } from '../../../../src/core/tracker.js';

const INPUT: ReportInput = {
  host: 'news.example.com',
  complaint: 'broken',
  outcomes: [{ remedy: 'light', result: 'still-broken', revert: 'reverted' }, { remedy: 'thorough', result: 'skipped', reason: 'noop' }],
  fixedBy: null,
  version: '1.0.317.600',
  chromeMajor: 155,
  level: 'standard',
  packs: ['ads', 'trackers', 'cookies'],
  rules: [{ rulesetId: 'ubo', ruleId: 4411 }, { rulesetId: 'easylist', ruleId: 1290 }],
  moreRules: 12,
  popupMode: 'smart',
  popups: null,
  access: 'all',
};

describe('buildReport (P2-15, UI notes §6)', () => {
  test('the planned lines: hostname only, what was tried, version, rules, pop-ups, site access', () => {
    expect(buildReport(INPUT)).toBe(
      [
        'Site: news.example.com (path and query are never included)',
        'Problem: the page looks broken · tried: Light mode (still broken)',
        'Version: 1.0.317.600 · Chrome 155 · level: Standard · packs: ads, trackers, cookies',
        'Matched rules: ubo#4411, easylist#1290 (+12)',
        'Pop-ups: smart',
        'Site access: all sites',
      ].join('\n'),
    );
  });

  test('fixed by a step; no rules; unknown Chrome; site and no access', () => {
    const text = buildReport({ ...INPUT, complaint: 'adThrough', outcomes: [], fixedBy: 'thorough', rules: [], moreRules: 0, chromeMajor: null, access: 'none' });
    expect(text).toContain('Problem: an ad or banner got through · fixed by: Thorough here');
    expect(text).toContain('Matched rules: none');
    expect(text).toContain('Chrome unknown');
    expect(text).toContain('Site access: none (Light mode)');
  });

  test('never a path, query, fragment or scheme, whatever the host field holds', () => {
    for (const host of ['news.example.com/a?b=1', 'https://news.example.com/', 'news.example.com#x', 'Evil Host']) {
      const text = buildReport({ ...INPUT, host });
      expect(text.split('\n')[0]).toBe('Site: (not included) (path and query are never included)');
      expect(text).not.toMatch(/\?b=1|https?:|\/a\b|#x|Evil/);
    }
  });

  test('capped at MAX_REPORT_CHARS', () => {
    const rules = Array.from({ length: 5_000 }, (_, i) => ({ rulesetId: 'ubo', ruleId: i + 1 }));
    expect(buildReport({ ...INPUT, rules }).length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
  });
});

describe('pop-ups line (P2-62)', () => {
  test('mode, count and codes from the sentinel; never a destination host; unknown codes dropped', () => {
    expect(buildReport({ ...INPUT, popups: { blocked: 2, codes: ['G11', 'G9', 'evil.example', 'TU'] } })).toContain('Pop-ups: smart · blocked 2 (G11, G9, TU)');
    expect(buildReport({ ...INPUT, popups: { blocked: 0, codes: [] } })).toContain('Pop-ups: smart · blocked 0\n');
    expect(buildReport({ ...INPUT, popupMode: 'strict' })).toContain('Pop-ups: strict\n');
  });

  test('the fourth complaint and the Strict remedy are worded', () => {
    expect(buildReport({ ...INPUT, complaint: 'popupOpened', outcomes: [{ remedy: 'strictPopups', result: 'still-broken' }] })).toContain(
      'Problem: an ad opened in a new tab or window · tried: Strict pop-ups (still broken)',
    );
  });
});

/** The value `src/core/tracker.ts` held before D-88; still refused. */
const PLACEHOLDER = 'https://github.com/OWNER/REPO-PLACEHOLDER';

describe('issue tracker URL (Q-11)', () => {
  test('the placeholder is not a tracker: Copy report only', () => {
    expect(trackerOf(PLACEHOLDER)).toBeNull();
  });

  test('the shipped tracker is the public repository (D-88) and passes validation', () => {
    expect(ISSUE_TRACKER_URL).toBe('https://github.com/Souayfan-Ali/Glassmere');
    expect(trackerOf(ISSUE_TRACKER_URL)).toBe(ISSUE_TRACKER_URL);
  });

  test.each([
    ['https://github.com/owner/repo', 'https://github.com/owner/repo'],
    ['https://github.com/owner/repo/', null],
    ['http://github.com/owner/repo', null],
    ['https://github.com.evil.example/owner/repo', null],
    ['https://github.com/owner', null],
    ['https://github.com/owner/repo/issues', null],
    ['https://user@github.com/owner/repo', null],
    ['javascript:alert(1)', null],
    ['https://github.com/owner/..', null],
    ['https://github.com/owner/repo.git', null],
  ])('%s → %s', (url, expected) => {
    expect(trackerOf(url)).toBe(expected);
  });

  test('issue URL: template, title and body encoded; over the cap the body asks to paste the copied report', () => {
    const tracker = 'https://github.com/owner/repo';
    const short = issueUrl(tracker, 'Broken: news.example.com', 'Site: news.example.com');
    expect(short).toEqual({
      url: 'https://github.com/owner/repo/issues/new?template=breakage.yml&title=Broken%3A+news.example.com&report=Site%3A+news.example.com',
      truncated: false,
    });
    const long = issueUrl(tracker, 'T', 'é'.repeat(MAX_ISSUE_URL_BYTES));
    expect(long.truncated).toBe(true);
    expect(new TextEncoder().encode(long.url).length).toBeLessThanOrEqual(MAX_ISSUE_URL_BYTES);
    expect(decodeURIComponent(new URL(long.url).searchParams.get('report') ?? '')).toBe('Paste the report here: it was copied to your clipboard.');
  });
});

describe('what reaches GitHub on "Open a new issue" (D-101 D)', () => {
  const HOSTILE = 'example.com/a?b=c#d';

  test('the shipped tracker: origin and path exactly the new-issue page; exactly three parameters', () => {
    const { url } = issueUrl(ISSUE_TRACKER_URL, reportTitle(INPUT), buildReport(INPUT));
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://github.com/Souayfan-Ali/Glassmere/issues/new');
    expect([...parsed.searchParams.keys()]).toEqual(['template', 'title', 'report']);
    expect(parsed.hash).toBe('');
  });

  test('a hostile host: title and body say "(not included)" and carry no "/", "?" or "#" from it', () => {
    const input = { ...INPUT, host: HOSTILE };
    const params = new URL(issueUrl(ISSUE_TRACKER_URL, reportTitle(input), buildReport(input)).url).searchParams;
    const title = params.get('title') ?? '';
    const report = params.get('report') ?? '';
    expect(title).toBe('The page looks broken: (not included)');
    expect(report.split('\n')[0]).toBe('Site: (not included) (path and query are never included)');
    // The body has rule ids such as "ubo#4411"; nothing else in it may carry a "/", "?" or "#".
    for (const text of [title, report.split('\n')[0] ?? '']) expect(text).not.toMatch(/[/?#]/);
    expect(report).not.toMatch(/[/?]|example\.com|b=c|#d/);
  });
});
