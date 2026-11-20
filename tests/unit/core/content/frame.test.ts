import { describe, expect, test } from 'vitest';
import { frameHost } from '../../../../src/core/content/frame.js';
import { isCommonData, isShardData, takeQueue } from '../../../../src/core/content/guard.js';

const loc = (hostname: string, origin: string, ancestors: readonly string[] = []) => ({ hostname, origin, ancestorOrigins: ancestors });

describe('frameHost (frames without a usable hostname, cosmetic notes §2.2)', () => {
  test.each([
    ['ordinary page', loc('www.example.com', 'https://www.example.com'), 'www.example.com'],
    ['upper case and trailing dot are normalised', loc('WWW.Example.com.', 'https://www.example.com'), 'www.example.com'],
    ['blob: frame takes the origin\'s host', loc('', 'https://frames.example'), 'frames.example'],
    ['about:blank takes the parent origin', loc('', 'null', ['https://frames.example', 'https://top.example']), 'frames.example'],
    ['nothing usable', loc('', 'null', []), null],
    ['IPv6 literal is not a hostname', loc('[::1]', 'https://[::1]'), null],
    ['garbage ancestor', loc('', 'null', ['not a url']), null],
  ])('%s', (_name, location, expected) => {
    expect(frameHost(location)).toBe(expected);
  });
});

const datum = {
  v: 1, pack: 'ads', shard: 3, hosts: ['a.com', 'b.com'],
  entries: [{ h: [0] }, { s: [0], j: [-1, 0] }],
  selectors: ['.ad'], styles: [['.x', 'opacity:0']], procedural: ['{"selector":".p"}'], invocations: [[0, 'arg']],
};

describe('hand-written guards for shard data (CONTRIBUTING.md: guards in content scripts)', () => {
  test('a well-formed shard datum passes', () => {
    expect(isShardData(datum)).toBe(true);
  });

  test.each([
    ['wrong version', { ...datum, v: 2 }],
    ['pack not a string', { ...datum, pack: 1 }],
    ['hosts unsorted', { ...datum, hosts: ['b.com', 'a.com'] }],
    ['entries length differs', { ...datum, entries: [{}] }],
    ['index not an integer', { ...datum, entries: [{ h: [0.5] }, {}] }],
    ['index out of its table', { ...datum, entries: [{ h: [7] }, {}] }],
    ['negative selector index', { ...datum, entries: [{ h: [-1] }, {}] }],
    ['style not a pair', { ...datum, styles: [['.x']] }],
    ['invocation argument not a string', { ...datum, invocations: [[0, 1]] }],
    ['invocation without a function index', { ...datum, invocations: [['x']] }],
    ['accessor instead of data', Object.defineProperty({ ...datum }, 'hosts', { get: () => ['a.com', 'b.com'], enumerable: true })],
    ['null', null],
    ['array', []],
  ])('rejects: %s', (_name, value) => {
    expect(isShardData(value)).toBe(false);
  });

  test('common data: invocations only, flagged common', () => {
    expect(isCommonData({ v: 1, pack: 'ads', common: true, invocations: [[1, 'a']] })).toBe(true);
    expect(isCommonData({ v: 1, pack: 'ads', common: false, invocations: [] })).toBe(false);
    expect(isCommonData(datum)).toBe(false);
  });
});

describe('takeQueue', () => {
  test('returns valid items, drops invalid ones and deletes the queue', () => {
    const scope: Record<string, unknown> = { __cs_q: [datum, { v: 9 }, { v: 1, pack: 'ads', common: true, invocations: [] }] };
    const got = takeQueue(scope, '__cs_q');
    expect(got.shards).toEqual([datum]);
    expect(got.common).toHaveLength(1);
    expect('__cs_q' in scope).toBe(false);
  });

  test('an accessor queue is not read and not called (page traps in a fresh realm)', () => {
    let reads = 0;
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, '__cs_q', { get: () => { reads += 1; return [datum]; }, configurable: true });
    expect(takeQueue(scope, '__cs_q')).toEqual({ shards: [], common: [] });
    expect(reads).toBe(0);
  });

  test('missing or non-array queue gives nothing', () => {
    expect(takeQueue({}, '__cs_q')).toEqual({ shards: [], common: [] });
    expect(takeQueue({ __cs_q: 'x' }, '__cs_q')).toEqual({ shards: [], common: [] });
  });
});
