import { describe, expect, test } from 'vitest';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { shapeProblem } from '../../../../compiler/validate/shape.js';

const rule = (condition: DnrRule['condition'], action: DnrRule['action'] = { type: 'block' }): DnrRule => ({ id: 1, priority: 10, action, condition });

describe('static rule shape check (P1-23, S-18)', () => {
  test.each<[string, DnrRule]>([
    ['plain host block', rule({ urlFilter: '||ads.example^' })],
    ['coalesced hosts', rule({ requestDomains: ['a.example', 'xn--mnchen-3ya.de'], resourceTypes: ['script'] })],
    ['regex', rule({ regexFilter: '^https://a\\.example/[0-9]+' })],
    ['leading wildcard written as *', rule({ urlFilter: '*/ads/*' })],
    ['allowAllRequests on frames', rule({ requestDomains: ['a.example'], resourceTypes: ['main_frame', 'sub_frame'] }, { type: 'allowAllRequests' })],
    ['resource redirect', rule({ urlFilter: '||a.example/x.js' }, { type: 'redirect', redirect: { extensionPath: '/surrogates/noop.js' } })],
    ['regex substitution', rule({ regexFilter: '^https://a\\.example/(.*)' }, { type: 'redirect', redirect: { regexSubstitution: 'https://b.example/\\1' } })],
    ['header removal', rule({ urlFilter: '||a.example^' }, { type: 'modifyHeaders', responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] })],
  ])('accepts %s', (_name, r) => {
    expect(shapeProblem(r)).toBeUndefined();
  });

  test.each<[string, DnrRule, RegExp]>([
    ['urlFilter starting with ||*', rule({ urlFilter: '||*.example^' }), /\|\|\*/],
    ['non-ASCII urlFilter', rule({ urlFilter: '||münchen.de^' }), /non-ASCII urlFilter/],
    ['empty urlFilter', rule({ urlFilter: '' }), /empty urlFilter/],
    ['urlFilter and regexFilter', rule({ urlFilter: '||a.example^', regexFilter: 'a' }), /both/],
    ['empty request domain list', rule({ requestDomains: [] }), /empty requestDomains/],
    ['non-ASCII domain', rule({ initiatorDomains: ['bücher.de'] }), /initiatorDomains.*bücher/],
    ['upper-case domain', rule({ requestDomains: ['Ads.example'] }), /requestDomains.*Ads/],
    ['empty resource type list', rule({ resourceTypes: [] }), /empty resourceTypes/],
    ['type in both lists', rule({ resourceTypes: ['script'], excludedResourceTypes: ['script'] }), /both resourceTypes and excludedResourceTypes/],
    ['allowAllRequests on a script', rule({ resourceTypes: ['script'] }, { type: 'allowAllRequests' }), /allowAllRequests/],
    ['allowAllRequests without types', rule({}, { type: 'allowAllRequests' }), /allowAllRequests/],
    ['redirect without a target', rule({}, { type: 'redirect' }), /exactly one redirect target/],
    ['two redirect targets', rule({}, { type: 'redirect', redirect: { extensionPath: '/a.js', url: 'https://a.example/' } }), /exactly one redirect target/],
    ['relative extension path', rule({}, { type: 'redirect', redirect: { extensionPath: 'a.js' } }), /extensionPath/],
    ['substitution without regex', rule({ urlFilter: '||a.example^' }, { type: 'redirect', redirect: { regexSubstitution: 'x' } }), /regexSubstitution needs regexFilter/],
    ['redirect data on a block', rule({}, { type: 'block', redirect: { extensionPath: '/a.js' } }), /redirect data on a block/],
    ['modifyHeaders without headers', rule({}, { type: 'modifyHeaders' }), /no header operation/],
    ['header set without value', rule({}, { type: 'modifyHeaders', requestHeaders: [{ header: 'x', operation: 'set' }] }), /needs a value/],
    ['header remove with value', rule({}, { type: 'modifyHeaders', requestHeaders: [{ header: 'x', operation: 'remove', value: 'v' }] }), /takes no value/],
    ['method in both lists', rule({ requestMethods: ['get'], excludedRequestMethods: ['get'] }), /requestMethods/],
  ])('rejects %s', (_name, r, why) => {
    expect(shapeProblem(r)).toMatch(why);
  });
});
