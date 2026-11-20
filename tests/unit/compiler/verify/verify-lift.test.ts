/**
 * D-55a item 8b: the verify stage re-checks `popup-lifted.json` against the emitted rulesets as a hard
 * assertion — every lifted host is a destination, keyed by a justifying ruleset that still document-blocks
 * it, touched by no malware document block and no stock main_frame allow, and the file equals the lift the
 * rulesets imply.
 */
import { describe, expect, test } from 'vitest';
import { verifyArtefacts } from '../../../../compiler/verify/verify.js';
import { b, built, POPUPS, UBO } from './helpers.js';

const DOC_BLOCK = b({ priority: 110, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], requestDomains: ['pop.example'] } });
const liftFailures = async (over: Parameters<typeof built>[0]) =>
  verifyArtefacts(await built(over)).failures.filter((f) => f.startsWith('popup-lifted.json'));

describe('popup-lifted.json checks (D-55a)', () => {
  test('the lift the rulesets imply passes; an empty file passes when nothing is document-blocked', async () => {
    expect(await liftFailures({ ubo: [...UBO, DOC_BLOCK], lifted: { ubo: ['pop.example'] } })).toEqual([]);
    expect(await liftFailures({})).toEqual([]);
  });

  test('a missing lift, an unknown key and a host that is not a destination fail', async () => {
    expect(await liftFailures({ ubo: [...UBO, DOC_BLOCK], lifted: {} })).toEqual(['popup-lifted.json: differs from the lift the rulesets imply']);
    expect(await liftFailures({ ubo: [...UBO, DOC_BLOCK], lifted: { ubo: ['pop.example'], 'cookies': ['pop.example'] } })).toContain('popup-lifted.json: key "cookies" is not a justifying ruleset');
    expect(await liftFailures({ lifted: { ubo: ['other.example'] } })).toContain('popup-lifted.json: 1 host(s) not in popup-destinations.json (e.g. other.example)');
  });

  test('each exclusion class is a failure of its own', async () => {
    const malware = b({ priority: 110, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], urlFilter: '||cdn.pop.example^' } });
    expect(await liftFailures({ ubo: [...UBO, DOC_BLOCK], badware: [malware], lifted: { ubo: ['pop.example'] } })).toContain('popup-lifted.json: malware: pop.example');
    expect(await liftFailures({ lifted: { ubo: ['pop.example'] } })).toContain('popup-lifted.json: unjustified: pop.example');
    // The popups ruleset's own `@@||ok.example^` never excludes; a stock allow on the host does.
    const allow = b({ priority: 100_010, action: { type: 'allow' }, condition: { resourceTypes: ['main_frame'], urlFilter: '||pop.example/ok' } });
    expect(await liftFailures({ ubo: [...UBO, DOC_BLOCK, allow], popups: POPUPS, lifted: { ubo: ['pop.example'] } })).toContain('popup-lifted.json: allow: pop.example');
  });

  test('a hostless stock main_frame allow fails the build', async () => {
    const hostless = b({ priority: 100_010, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['main_frame'], urlFilter: '/checkout' } });
    expect(await liftFailures({ ubo: [...UBO, hostless] })).toEqual([expect.stringMatching(/^popup-lifted\.json: hostless main_frame allow: ubo#\d+$/)]);
  });
});
