import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { entityFormsOf, expandEntity, isEntityPattern } from '../../../../src/core/hostname/entity.js';
import { shardKey, lookupSharded, shardEntries } from '../../../../src/core/hostname/shard.js';
import { isCanonicalHostname, parseHostname } from '../../../../src/core/hostname/validate.js';
import { isSameOrSubdomain, parentDomains } from '../../../../src/core/hostname/walk.js';
import type { Hostname } from '../../../../src/core/ids.js';
import { SHARD_COUNT } from '../../../../src/core/limits.js';

const h = (s: string): Hostname => parseHostname(s) ?? expect.fail(`bad host ${s}`);

const label = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,6}[a-z0-9])?$/);
const hostArb = fc.array(label, { minLength: 1, maxLength: 5 }).map((labels) => h(labels.join('.')));

describe('parseHostname', () => {
  test.each([
    ['example.com', 'example.com'],
    ['WWW.Example.COM', 'www.example.com'],
    ['example.com.', 'example.com'],
    ['localhost', 'localhost'],
    ['192.168.0.1', '192.168.0.1'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['a_b.example.com', 'a_b.example.com'],
    ['a-b.c', 'a-b.c'],
  ])('accepts %s as %s', (input, expected) => {
    expect(parseHostname(input)).toBe(expected);
  });

  test.each([
    '',
    '.',
    '.example.com',
    'example..com',
    '-a.com',
    'a-.com',
    'exa mple.com',
    'example.com/path',
    'user@example.com',
    'example.com:80',
    '*.example.com',
    'google.*',
    '[::1]',
    'bücher.example',
    `${'a'.repeat(64)}.com`,
    `${'a'.repeat(60)}.`.repeat(5) + 'com',
    '__proto__',
    '__PROTO__',
    '__proto__.example.com',
    // P2-43: Valibot records drop these keys, so a level set on them would vanish on the next read.
    'constructor',
    'Prototype',
  ])('rejects %j', (input) => {
    expect(parseHostname(input)).toBeNull();
  });

  test('rejects non-strings', () => {
    expect(parseHostname(1)).toBeNull();
    expect(parseHostname(null)).toBeNull();
  });

  test('accepts a 253-character name', () => {
    const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(name).toHaveLength(253);
    expect(parseHostname(name)).toBe(name);
  });
});

describe('parentDomains', () => {
  test('walks from the host to its last label', () => {
    expect(parentDomains(h('a.b.example.com'))).toEqual(['a.b.example.com', 'b.example.com', 'example.com', 'com']);
  });

  test('equals brute force: every candidate the host is the same as or a subdomain of', () => {
    fc.assert(
      fc.property(hostArb, hostArb, (host, other) => {
        expect(parentDomains(host).includes(other)).toBe(isSameOrSubdomain(host, other));
        expect(isSameOrSubdomain(host, other)).toBe(host === other || host.endsWith(`.${other}`));
      }),
    );
  });

  test('does not treat a suffix match inside a label as a parent', () => {
    expect(isSameOrSubdomain(h('badexample.com'), h('example.com'))).toBe(false);
  });
});

describe('entity forms', () => {
  test('recognises entity patterns', () => {
    expect(isEntityPattern('google.*')).toBe(true);
    expect(isEntityPattern('www.google.*')).toBe(true);
    expect(isEntityPattern('google.com')).toBe(false);
    expect(isEntityPattern('*.google.com')).toBe(false);
    expect(isEntityPattern('.*')).toBe(false);
  });

  test('lists the entity forms of a host above its public suffix', () => {
    expect(entityFormsOf(h('www.google.co.uk'), h('co.uk'))).toEqual(['www.google.*', 'google.*']);
    expect(entityFormsOf(h('google.com'), h('com'))).toEqual(['google.*']);
  });

  test('returns nothing when the suffix is not a suffix of the host', () => {
    expect(entityFormsOf(h('google.com'), h('co.uk'))).toEqual([]);
    expect(entityFormsOf(h('co.uk'), h('co.uk'))).toEqual([]);
  });

  test('expands an entity against a suffix table, dropping invalid results', () => {
    expect(expandEntity('google.*', ['com', 'co.uk', 'bad suffix'])).toEqual(['google.com', 'google.co.uk']);
    expect(expandEntity('google.com', ['com'])).toEqual([]);
  });

  test('round-trips: every expanded host has the entity among its forms', () => {
    fc.assert(
      fc.property(hostArb, hostArb, (name, suffix) => {
        const entity = `${name}.*`;
        const [host] = expandEntity(entity, [suffix]);
        expect(host && entityFormsOf(host, suffix)).toContain(entity);
      }),
    );
  });
});

describe('shardKey', () => {
  test('is the FNV-1a hash of the last two labels, modulo the shard count (S-04)', () => {
    expect(shardKey(h('www.example.com'))).toBe(shardKey(h('example.com')));
    expect(shardKey(h('example.com'))).toBe(fnvReference('example.com') % SHARD_COUNT);
    expect(shardKey(h('localhost'))).toBe(fnvReference('localhost') % SHARD_COUNT);
  });

  test('stays inside the shard range', () => {
    fc.assert(
      fc.property(hostArb, (host) => {
        const key = shardKey(host);
        expect(Number.isInteger(key) && key >= 0 && key < SHARD_COUNT).toBe(true);
      }),
    );
  });
});

describe('sharded lookup', () => {
  test('finds exactly the entries a brute-force scan finds', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(hostArb, fc.integer()), { maxLength: 30 }), hostArb, (entries, host) => {
        const shards = shardEntries(entries);
        const brute = entries.filter(([key]) => isSameOrSubdomain(host, key)).map(([, value]) => value);
        expect([...lookupSharded(shards, host)].sort()).toEqual([...brute].sort());
      }),
    );
  });

  test('does not modify its input', () => {
    const entries = Object.freeze([Object.freeze([h('a.com'), 1] as const)]);
    expect(() => shardEntries(entries)).not.toThrow();
  });
});

function fnvReference(text: string): number {
  let hash = 2166136261;
  for (const ch of text) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return hash >>> 0;
}

describe('isCanonicalHostname (P1-35 fast path)', () => {
  test('agrees with parseHostname(h) === h on generated strings', () => {
    const chars = fc.constantFrom(...'abz09-_.A'.split(''), '__proto__', '.', 'é');
    fc.assert(fc.property(fc.array(chars, { maxLength: 40 }).map((a) => a.join('')), (h) => isCanonicalHostname(h) === (parseHostname(h) === h)), { numRuns: 3000 });
  });

  test.each(['example.com', 'a', '_dmarc.x.org', `${'a'.repeat(63)}.com`, 'constructor.example.com'])('accepts %s', (h) => {
    expect(isCanonicalHostname(h)).toBe(true);
  });

  test.each(['Example.com', 'example.com.', '-a.com', `${'a'.repeat(64)}.com`, 'a..b', '__proto__.com', 'constructor', 'prototype', '', `${'a.'.repeat(127)}aa`])('refuses %s', (h) => {
    expect(isCanonicalHostname(h)).toBe(false);
  });
});
