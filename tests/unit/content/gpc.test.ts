import { describe, expect, test } from 'vitest';
import { defineGpc } from '../../../src/content/gpc/property.js';

describe('GPC property (P2-31)', () => {
  test('defines navigator.globalPrivacyControl === true on the prototype, configurable, once', () => {
    const proto = {};
    defineGpc(proto);
    const nav = Object.create(proto) as { globalPrivacyControl?: boolean };
    expect(nav.globalPrivacyControl).toBe(true);
    expect(Object.getOwnPropertyDescriptor(proto, 'globalPrivacyControl')).toMatchObject({ configurable: true, enumerable: true });
  });

  test('leaves a native or earlier definition alone; no prototype → no-op', () => {
    const proto = {};
    Object.defineProperty(proto, 'globalPrivacyControl', { get: () => false, configurable: true });
    defineGpc(proto);
    expect((Object.create(proto) as { globalPrivacyControl?: boolean }).globalPrivacyControl).toBe(false);
    expect(() => {
      defineGpc(undefined);
    }).not.toThrow();
  });
});
