// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { findHinted } from '../../../../src/content/picker/hint.js';
import { parsePickHint } from '../../../../src/content/picker/start.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('parsePickHint (P3-17 item 2: the content script checks the hint again)', () => {
  test('accepts a kind and an http(s) URL', () => {
    expect(parsePickHint({ kind: 'image', url: 'https://a.example/p.png' })).toEqual({ kind: 'image', url: 'https://a.example/p.png' });
    expect(parsePickHint({ kind: 'frame', url: 'http://a.example/' })).toEqual({ kind: 'frame', url: 'http://a.example/' });
  });

  test.each([
    ['null', null],
    ['an array', []],
    ['an unknown kind', { kind: 'script', url: 'https://a.example/' }],
    ['an extra key', { kind: 'link', url: 'https://a.example/', selector: '#x' }],
    ['a missing url', { kind: 'link' }],
    ['a non-http URL', { kind: 'link', url: 'javascript:void 0' }],
    ['an unparsable URL', { kind: 'link', url: 'https://' }],
    ['a URL past the cap', { kind: 'link', url: `https://a.example/${'x'.repeat(2100)}` }],
  ])('refuses %s', (_name, value) => {
    expect(parsePickHint(value)).toBeNull();
  });
});

describe('findHinted: compares attributes with the hint, never builds a selector from it', () => {
  test('an image by its resolved src, a frame, a link, a video', () => {
    document.body.innerHTML = '<img id="a" src="/x.png"><img id="b" src="https://cdn.example/p.png"><iframe id="f" src="https://ads.example/f.html"></iframe><a id="l" href="go?x=1">x</a><video id="v" src="v.mp4"></video>';
    expect(findHinted(document, { kind: 'image', url: 'https://cdn.example/p.png' })?.id).toBe('b');
    expect(findHinted(document, { kind: 'image', url: new URL('/x.png', document.baseURI).href })?.id).toBe('a');
    expect(findHinted(document, { kind: 'frame', url: 'https://ads.example/f.html' })?.id).toBe('f');
    expect(findHinted(document, { kind: 'link', url: new URL('go?x=1', document.baseURI).href })?.id).toBe('l');
    expect(findHinted(document, { kind: 'video', url: new URL('v.mp4', document.baseURI).href })?.id).toBe('v');
  });

  test('no element with that URL, or one of another kind: none (the picker starts as before)', () => {
    document.body.innerHTML = '<img src="https://cdn.example/p.png"><a href="https://cdn.example/p.png">x</a>';
    expect(findHinted(document, { kind: 'image', url: 'https://cdn.example/other.png' })).toBeNull();
    expect(findHinted(document, { kind: 'frame', url: 'https://cdn.example/p.png' })).toBeNull();
  });

  test('a hint URL with selector syntax is only compared, never parsed as a selector', () => {
    document.body.innerHTML = '<img id="q" src="https://a.example/p.png?a=&quot;]),*">';
    const url = new URL('https://a.example/p.png?a="]),*').href;
    expect(findHinted(document, { kind: 'image', url })?.id).toBe('q');
  });
});
