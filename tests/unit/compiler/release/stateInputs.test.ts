/**
 * D-71: the keyless `state` job takes ledgers and id maps from the untrusted candidate artefact, so they are
 * checked against the CHECKED zip, and the counts are derived from the zip bytes instead of read from the artefact.
 */
import { describe, expect, test } from 'vitest';
import { checkedStateInputs } from '../../../../compiler/release/stateInputs.js';
import { extensionZip, text } from './fixtures.js';

const rules = (...ids: number[]): string => JSON.stringify(ids.map((id) => ({ id, priority: 10, action: { type: 'block' }, condition: { requestDomains: [`h${String(id)}.example`] } })));
const regexRule = JSON.stringify([{ id: 3, priority: 10, action: { type: 'block' }, condition: { regexFilter: '^https://a\\.example/' } }]);
const ZIP = extensionZip({ files: { 'catalog.json': '{}', 'rulesets/ubo.json': rules(1, 2), 'rulesets/ubo-x.json': '[]', 'rulesets/easylist.json': regexRule } });
const ledger = (slot: string, ids: readonly number[]): string =>
  JSON.stringify({ schema: 1, ruleset: slot, nextId: Math.max(0, ...ids) + 1, entries: Object.fromEntries(ids.map((id) => [`b:k${String(id)}`, id])) });
const idmap = (ids: readonly number[]): Uint8Array => text(JSON.stringify(Object.fromEntries(ids.map((id) => [String(id), [{ list: 'l', line: 1, text: 'x' }]]))));
const LEDGERS = new Map([['ubo', ledger('ubo', [1, 2])], ['easylist', ledger('easylist', [3])]]);
const IDMAPS = new Map([['ubo.json', idmap([1, 2])], ['easylist.json', idmap([3])]]);

describe('checkedStateInputs (D-71)', () => {
  test('counts come from the zip, sorted, in the counts-file format; empty slots need no ledger or id map', () => {
    expect(checkedStateInputs(ZIP, LEDGERS, IDMAPS).counts).toBe(`${JSON.stringify({ schema: 1, slots: {
      easylist: { rules: 1, regex: 1 }, ubo: { rules: 2, regex: 0 }, 'ubo-x': { rules: 0, regex: 0 } } }, null, 2)}\n`);
  });

  test.each([
    ['a rule id missing from its ledger', new Map([...LEDGERS, ['ubo', ledger('ubo', [1])]]), IDMAPS, /ubo: rule id\(s\) 2 not in the ledger/],
    ['a slot with rules and no ledger', new Map([['easylist', ledger('easylist', [3])]]), IDMAPS, /ubo: no ledger/],
    ['a ledger for another ruleset', new Map([...LEDGERS, ['ubo', ledger('easylist', [1, 2])]]), IDMAPS, /ubo: the ledger names ruleset "easylist"/],
    ['a ledger for an unknown slot', new Map([...LEDGERS, ['evil', ledger('evil', [1])]]), IDMAPS, /ledger for a ruleset the zip does not declare: evil/],
    ['a ledger that is not a ledger', new Map([...LEDGERS, ['ubo', '{"x":1}']]), IDMAPS, /ubo/],
    ['a rule id missing from its id map', LEDGERS, new Map([...IDMAPS, ['ubo.json', idmap([2])]]), /ubo: rule id\(s\) 1 not in the id map/],
    ['a slot with rules and no id map', LEDGERS, new Map([['ubo.json', idmap([1, 2])]]), /easylist: no id map/],
    ['an id map for an unknown slot', LEDGERS, new Map([...IDMAPS, ['evil.json', idmap([1])]]), /id map for a ruleset the zip does not declare: evil/],
    ['an id map that is not JSON', LEDGERS, new Map([...IDMAPS, ['ubo.json', text('[')]]), /ubo: the id map is not a JSON object/],
    // Security review MEDIUM 4: only canonical ids, and only source lists as values.
    ['a non-canonical id map key', LEDGERS, new Map([...IDMAPS, ['ubo.json', text('{"01":[],"2":[]}')]]), /ubo: id map key "01" is not a rule id/],
    ['an id map value that is not a source list', LEDGERS, new Map([...IDMAPS, ['ubo.json', text('{"1":[{"list":"l","line":1,"text":"x"}],"2":"evil"}')]]), /ubo: id map entry 2 is not a list of sources/],
    ['an id map source with a wrong shape', LEDGERS, new Map([...IDMAPS, ['ubo.json', text('{"1":[{"list":1}],"2":[]}')]]), /ubo: id map entry 1 is not a list of sources/],
  ])('%s → throws', (_name, ledgers, idmaps, message) => {
    expect(() => checkedStateInputs(ZIP, ledgers, idmaps)).toThrow(message);
  });

  test('a declared ruleset missing from the zip throws', () => {
    const bad = extensionZip({ files: { 'rulesets/ubo.json': rules(1, 2), 'rulesets/easylist.json': '[]' } });
    expect(() => checkedStateInputs(bad, LEDGERS, IDMAPS)).toThrow(/zip has no rulesets\/ubo-x\.json/);
  });

  test('more than five missing ids are listed with a count; files that are not .json are ignored', () => {
    const many = extensionZip({ files: { 'rulesets/ubo.json': rules(1, 2, 3, 4, 5, 6, 7), 'rulesets/ubo-x.json': '[]', 'rulesets/easylist.json': '[]' } });
    const idmaps = new Map([['ubo.json', idmap([1, 2, 3, 4, 5, 6, 7])], ['README.txt', text('x')]]);
    expect(() => checkedStateInputs(many, new Map([['ubo', ledger('ubo', [1])]]), idmaps)).toThrow(/ubo: rule id\(s\) 2, 3, 4, 5, 6 \(\+1\) not in the ledger/);
  });

  test('a zip ruleset that is not a DNR rule list throws', () => {
    const bad = extensionZip({ files: { 'rulesets/ubo.json': '[{"id":1}]', 'rulesets/ubo-x.json': '[]', 'rulesets/easylist.json': '[]' } });
    expect(() => checkedStateInputs(bad, LEDGERS, IDMAPS)).toThrow(/rulesets\/ubo\.json is not a DNR rule list/);
  });
});
