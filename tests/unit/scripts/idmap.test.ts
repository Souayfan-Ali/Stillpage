import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { handle, readEvent, type BotComment, type Gh } from '../../../scripts/idmap/bot.js';
import { commentFor, COMMENT_MARKER, KNOWN_LABELS, labelsFor, MAX_REFS, parseReport, readIdMap } from '../../../scripts/idmap/resolve.js';

const SAMPLE = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../fixtures/idmap/issue-opened.json'), 'utf8')) as unknown;

const IDMAPS: Readonly<Record<string, Record<string, unknown>>> = {
  ubo: { '4411': [{ list: 'ubo-filters', line: 120, text: 'example.com##.ad' }] },
  easylist: { '1290': [{ list: 'easylist', line: 77, text: '||ads.example^ ``` @attacker' }] },
};

function fakeGh(existing: readonly BotComment[] = [], maps: Readonly<Record<string, Record<string, unknown>>> = IDMAPS) {
  const calls: string[] = [];
  const asked: string[] = [];
  const gh: Gh = {
    idMap: (version, rulesetId) => {
      asked.push(`${version} ${rulesetId}`);
      return Promise.resolve(maps[rulesetId] ?? null);
    },
    comments: () => Promise.resolve(existing),
    createComment: (issue, body) => {
      calls.push(`create ${String(issue)} ${String(body.length)}`);
      return Promise.resolve();
    },
    updateComment: (id) => {
      calls.push(`update ${String(id)}`);
      return Promise.resolve();
    },
    addLabels: (issue, labels) => {
      calls.push(`labels ${String(issue)} ${labels.join(',')}`);
      return Promise.resolve();
    },
  };
  return { gh, calls, asked };
}

describe('id-resolution bot on a sample issue payload (P2-16)', () => {
  test('reads the event; ignores other actions and bots', () => {
    expect(readEvent(SAMPLE)).toMatchObject({ action: 'opened', issue: 42 });
    expect(readEvent({ ...(SAMPLE as object), action: 'closed' })).toBeNull();
    expect(readEvent({ ...(SAMPLE as object), sender: { type: 'Bot' } })).toBeNull();
    expect(readEvent({ action: 'opened', issue: { number: -1 } })).toBeNull();
    expect(readEvent(null)).toBeNull();
  });

  test('parses the version and the matched-rule tokens only: deduplicated, static ids, no garbage', () => {
    const event = readEvent(SAMPLE);
    expect(parseReport(event?.body ?? '')).toEqual({
      version: '1.0.317.600',
      refs: [
        { rulesetId: 'ubo', ruleId: 4411 },
        { rulesetId: 'easylist', ruleId: 1290 },
      ],
    });
    expect(parseReport('Version: 1.0.317.600 --upload\nMatched rules: ubo#1').version).toBe('1.0.317.600');
    expect(parseReport('Version: -1.0.0.0\nMatched rules: ubo#1').version).toBeNull();
    expect(parseReport('Version: 01.0.0.0').version).toBeNull();
    const many = `Version: 1.0.1.1\nMatched rules: ${Array.from({ length: 50 }, (_, i) => `ubo#${String(i + 1)}`).join(', ')}`;
    expect(parseReport(many).refs).toHaveLength(MAX_REFS);
  });

  test('one comment with the source filters in a fence longer than any backtick run, mentions defused; one upstream label', async () => {
    const { gh, calls, asked } = fakeGh();
    const event = readEvent(SAMPLE);
    if (event === null) throw new Error('sample not read');
    const { comment, labels } = await handle(event, gh);
    expect(asked).toEqual(['1.0.317.600 ubo', '1.0.317.600 easylist']);
    expect(comment.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment).toContain('ubo#4411:\n```text\nubo-filters:120  example.com##.ad\n```');
    expect(comment).toContain('````text\neasylist:77  ||ads.example^ ``` @​attacker\n````');
    expect(comment).not.toContain('@someone');
    expect(comment).not.toContain('rm -rf');
    expect(labels).toEqual([]);
    expect(calls).toEqual([`create 42 ${String(comment.length)}`]);
  });

  test('labels: only when every filter comes from one known upstream project', () => {
    const one = new Map([['ubo#1', [{ list: 'ubo-filters', line: 1, text: 'x' }]], ['ubo#2', [{ list: 'ubo-privacy', line: 2, text: 'y' }]]]);
    expect(labelsFor(one)).toEqual(['upstream:ubo']);
    expect(labelsFor(new Map([['a#1', [{ list: 'easyprivacy', line: 1, text: 'x' }]]]))).toEqual(['upstream:easylist']);
    expect(labelsFor(new Map([['a#1', [{ list: 'unknown-list', line: 1, text: 'x' }]]]))).toEqual([]);
    expect(labelsFor(new Map())).toEqual([]);
    expect([...KNOWN_LABELS].every((l) => /^upstream:[a-z]+$/.test(l))).toBe(true);
  });

  test('an edit updates our existing comment (by marker and author), never posts a second one', async () => {
    const event = readEvent({ ...(SAMPLE as object), action: 'edited' });
    if (event === null) throw new Error('sample not read');
    const theirs: BotComment = { id: 1, body: `${COMMENT_MARKER} forged by a user`, ours: false };
    const ours: BotComment = { id: 2, body: `${COMMENT_MARKER}\nold`, ours: true };
    const { gh, calls } = fakeGh([theirs, ours], { ubo: IDMAPS['ubo'] ?? {} });
    const { labels } = await handle(event, gh);
    expect(calls).toEqual(['update 2', 'labels 42 upstream:ubo']);
    expect(labels).toEqual(['upstream:ubo']);
  });

  test('clean comments for no version, no rules and no published id map', async () => {
    for (const [body, text] of [
      ['Matched rules: ubo#1', 'No `Version:` line was found'],
      ['Version: 1.0.317.600\nMatched rules: none', 'the report names no matched rules'],
      ['Version: 1.0.9.9\nMatched rules: ubo#1', 'no id map is published for this version'],
    ] as const) {
      const { gh } = fakeGh([], {});
      expect((await handle({ action: 'opened', issue: 7, body }, gh)).comment).toContain(text);
    }
    expect(commentFor({ kind: 'no-version' }).startsWith(COMMENT_MARKER)).toBe(true);
  });

  test('bidi overrides and invisible characters in filter text are removed', async () => {
    const { gh } = fakeGh([], { ubo: { '1': [{ list: 'ubo-filters', line: 1, text: 'a\u202Eb\u2066c\u200Bd\uFEFFe' }] } });
    const { comment } = await handle({ action: 'opened', issue: 9, body: 'Version: 1.0.1.1\nMatched rules: ubo#1' }, gh);
    expect(comment).toContain('ubo-filters:1  abcde');
  });

  test('id maps are validated: wrong shapes are treated as missing', () => {
    expect(readIdMap({ '1': [{ list: 'a', line: 1, text: 't' }] })?.get(1)).toHaveLength(1);
    for (const bad of [null, [], { x: [] }, { '1': 'no' }, { '1': [{ list: 1, line: 1, text: 't' }] }]) {
      expect(readIdMap(bad)).toBeNull();
    }
  });
});
