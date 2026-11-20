import { describe, expect, test } from 'vitest';
import { hintFromMenuClick } from '../../../src/background/pickerHint.js';

const base = { menuItemId: 'hide-element', editable: false, pageUrl: 'https://news.example/a', frameId: 0 };

describe('hintFromMenuClick (P3-17 item 2: the right-clicked element, validated in the worker)', () => {
  test('an image, a video, a link, a sub-frame', () => {
    expect(hintFromMenuClick({ ...base, mediaType: 'image', srcUrl: 'https://cdn.example/p.png' })).toEqual({ kind: 'image', url: 'https://cdn.example/p.png' });
    expect(hintFromMenuClick({ ...base, mediaType: 'video', srcUrl: 'http://cdn.example/v.mp4' })).toEqual({ kind: 'video', url: 'http://cdn.example/v.mp4' });
    expect(hintFromMenuClick({ ...base, linkUrl: 'https://ads.example/go' })).toEqual({ kind: 'link', url: 'https://ads.example/go' });
    expect(hintFromMenuClick({ ...base, frameId: 4, frameUrl: 'https://ads.example/f.html', mediaType: 'image', srcUrl: 'https://ads.example/i.png' })).toEqual({ kind: 'frame', url: 'https://ads.example/f.html' });
  });

  test('an image inside a link: the image', () => {
    expect(hintFromMenuClick({ ...base, mediaType: 'image', srcUrl: 'https://cdn.example/p.png', linkUrl: 'https://ads.example/go' })).toEqual({ kind: 'image', url: 'https://cdn.example/p.png' });
  });

  test.each([
    ['nothing to point at', base],
    ['not an object', 'x'],
    ['null', null],
    ['a data: image', { ...base, mediaType: 'image', srcUrl: 'data:image/png;base64,AAAA' }],
    ['a javascript: link', { ...base, linkUrl: 'javascript:alert(1)' }],
    ['a URL past the cap', { ...base, linkUrl: `https://a.example/${'x'.repeat(2100)}` }],
    ['a non-string URL', { ...base, linkUrl: 7 }],
    ['an unknown media type', { ...base, mediaType: 'canvas', srcUrl: 'https://a.example/x' }],
    ['a frame id that is not an integer', { ...base, frameId: 'x', frameUrl: 'https://a.example/' }],
    ['top frame with a frameUrl only', { ...base, frameUrl: 'https://a.example/' }],
  ])('none for %s', (_name, info) => {
    expect(hintFromMenuClick(info)).toBeNull();
  });
});
