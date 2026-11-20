import { describe, expect, test } from 'vitest';
import { expandEntities, isEntity, stemIndex } from '../../../../compiler/entities/expand.js';

describe('observed entity expansion (D-20)', () => {
  test('name.* becomes the name.<suffix> hosts the build names, suffix of one or two labels', () => {
    const index = stemIndex(['google.de', 'google.co.uk', 'www.google.com', 'google.a.b.c', 'googleads.com', 'google.de']);
    expect(expandEntities(['google.*', 'www.google.*', 'nowhere.*'], index)).toEqual({
      hosts: ['google.co.uk', 'google.de', 'www.google.com'], lost: ['nowhere.*'],
    });
  });

  test('only a public-suffix-like ending expands: never google.evil.com or www.anything (P1-49 review)', () => {
    const index = stemIndex(['google.evil.com', 'www.shop.example', 'google.com.au']);
    expect(expandEntities(['google.*', 'www.*'], index)).toEqual({ hosts: ['google.com.au'], lost: ['www.*'] });
  });

  test('recognises entity forms only', () => {
    expect(isEntity('google.*')).toBe(true);
    expect(isEntity('mail.google.*')).toBe(true);
    expect(isEntity('google.com')).toBe(false);
    expect(isEntity('*.google.com')).toBe(false);
  });
});
