import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { MESSAGE_TYPES, parseMessage, type SenderInfo } from '../../../../src/core/messaging/parse.js';
import { classifySender } from '../../../../src/core/messaging/sender.js';
import { MAX_BACKUP_BYTES } from '../../../../src/core/limits.js';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT = `chrome-extension://${RUNTIME_ID}`;

const POPUP: SenderInfo = { id: RUNTIME_ID, url: `${EXT}/popup.html`, origin: EXT };
const DASHBOARD_TAB: SenderInfo = { id: RUNTIME_ID, url: `${EXT}/dashboard.html#sites`, origin: EXT, tab: { id: 4 }, frameId: 0 };
const PICKER_FRAME: SenderInfo = { id: RUNTIME_ID, url: `${EXT}/picker-panel.html`, origin: EXT, tab: { id: 9 }, frameId: 3 };
const BLOCKED: SenderInfo = { id: RUNTIME_ID, url: `${EXT}/blocked.html#https://ads.test/`, origin: EXT, tab: { id: 12 }, frameId: 0 };
const CONTENT: SenderInfo = { id: RUNTIME_ID, url: 'https://news.test/a', origin: 'https://news.test', tab: { id: 4 }, frameId: 0 };
const OTHER_EXT: SenderInfo = { id: 'ponmlkjihgfedcbaponmlkjihgfedcba', url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/x.html' };
const SPOOFED_URL: SenderInfo = { id: RUNTIME_ID, url: `${EXT}/popup.html`, origin: 'https://evil.test', tab: { id: 1 } };

const envelope = (type: string, payload: unknown, extra: Record<string, unknown> = {}): unknown => ({
  v: 1,
  type,
  id: 'm1',
  payload,
  ...extra,
});

/** One valid payload per message type. */
const VALID: Record<(typeof MESSAGE_TYPES)[number], unknown> = {
  'q/tabState': { tabId: 1 },
  'q/matchedRules': { tabId: 1 },
  'c/setSiteLevel': { hostname: 'news.test', level: 'inherit' },
  'c/pauseSite': { hostname: 'news.test', minutes: 30 },
  'c/dismissNotice': {},
  'c/setPopupNotice': { enabled: false },
  'c/setDefaultLevel': { level: 'thorough' },
  'c/setPack': { pack: 'cookies', enabled: true },
  'c/setGpc': { enabled: false },
  'c/startPicker': { tabId: 3, mode: 'zap' },
  'c/saveUserFilter': { hostname: 'news.test', selector: '.ad-box', nonce: 'n0nce-0123456789ab' },
  'c/removeUserFilter': { hostname: 'news.test', selector: '#banner' },
  'c/importBackup': { json: '{}', expect: 'ab'.repeat(32) },
  'c/setPopupMode': { mode: 'smart' },
  'c/setSitePopupPolicy': { hostname: 'news.test', policy: 'allow' },
  'c/proceedOnce': { hostname: 'ads.test' },
  'c/reconcile': {},
  'cs/cssFallback': { registration: 'iso:ads:17' },
  'q/dashboard': {},
  'c/forgetSites': { hostnames: ['news.test'] },
  'c/setShowBadge': { enabled: true },
  'c/completeOnboarding': {},
  'q/previewBackup': { json: '{}' },
};

const isContentScriptMessage = (type: string): boolean => type.startsWith('cs/');

describe('classifySender', () => {
  test.each([
    ['popup', POPUP, 'extension-page'],
    ['dashboard in a tab', DASHBOARD_TAB, 'extension-page'],
    ['picker iframe inside a page', PICKER_FRAME, 'extension-page'],
    ['content script', CONTENT, 'content-script'],
    ['another extension', OTHER_EXT, 'foreign'],
    ['extension url with a web origin', SPOOFED_URL, 'foreign'],
    ['no id', { url: `${EXT}/popup.html` }, 'foreign'],
    ['no url', { id: RUNTIME_ID }, 'foreign'],
    ['unparsable url', { id: RUNTIME_ID, url: 'not a url', tab: { id: 1 } }, 'foreign'],
  ] as const)('%s → %s', (_name, sender, kind) => {
    expect(classifySender(sender, RUNTIME_ID)).toBe(kind);
  });
});

describe('parseMessage: accepted', () => {
  test.each(MESSAGE_TYPES.filter((t) => !isContentScriptMessage(t) && t !== 'c/proceedOnce'))('%s from the popup', (type) => {
    const result = parseMessage(envelope(type, VALID[type]), POPUP, RUNTIME_ID);
    expect(result).toMatchObject({ ok: true, value: { type, id: 'm1' } });
  });

  test('c/proceedOnce from blocked.html carries the sender tab, never a payload tab', () => {
    const result = parseMessage(envelope('c/proceedOnce', { hostname: 'ads.test', tabId: 99 }), BLOCKED, RUNTIME_ID);
    expect(result).toMatchObject({ ok: false, errors: { code: 'invalid-payload' } });
    const accepted = parseMessage(envelope('c/proceedOnce', { hostname: 'ads.test' }), BLOCKED, RUNTIME_ID);
    expect(accepted).toEqual({ ok: true, value: { type: 'c/proceedOnce', id: 'm1', payload: { hostname: 'ads.test' }, senderTabId: 12, senderFrameId: 0 } });
  });

  test('cs/cssFallback from a content script carries its tab and frame', () => {
    const result = parseMessage(envelope('cs/cssFallback', VALID['cs/cssFallback']), CONTENT, RUNTIME_ID);
    expect(result).toMatchObject({ ok: true, value: { type: 'cs/cssFallback', senderTabId: 4, senderFrameId: 0 } });
  });

  test('the picker panel may save a user filter', () => {
    expect(parseMessage(envelope('c/saveUserFilter', VALID['c/saveUserFilter']), PICKER_FRAME, RUNTIME_ID).ok).toBe(true);
  });
});

describe('parseMessage: rejected', () => {
  test.each(MESSAGE_TYPES.filter((t) => !isContentScriptMessage(t)))('%s from a content script', (type) => {
    const result = parseMessage(envelope(type, VALID[type]), CONTENT, RUNTIME_ID);
    expect(result).toMatchObject({ ok: false, errors: { code: 'forbidden-sender' } });
  });

  test.each(MESSAGE_TYPES)('%s from another extension or a spoofed origin', (type) => {
    for (const sender of [OTHER_EXT, SPOOFED_URL]) {
      expect(parseMessage(envelope(type, VALID[type]), sender, RUNTIME_ID)).toMatchObject({ ok: false, errors: { code: 'forbidden-sender' } });
    }
  });

  test('c/proceedOnce is accepted only from blocked.html as a top-level document', () => {
    for (const sender of [POPUP, DASHBOARD_TAB, PICKER_FRAME, { ...BLOCKED, frameId: 2 }, { ...BLOCKED, frameId: undefined }]) {
      expect(parseMessage(envelope('c/proceedOnce', VALID['c/proceedOnce']), sender, RUNTIME_ID)).toMatchObject({
        ok: false,
        errors: { code: 'forbidden-sender' },
      });
    }
  });

  test('cs/cssFallback is rejected from extension pages', () => {
    expect(parseMessage(envelope('cs/cssFallback', VALID['cs/cssFallback']), POPUP, RUNTIME_ID)).toMatchObject({
      ok: false,
      errors: { code: 'forbidden-sender' },
    });
  });

  test.each([
    ['unknown type', envelope('c/doEverything', {}), 'unknown-type'],
    ['prototype key as type', envelope('constructor', {}), 'unknown-type'],
    ['wrong version', envelope('c/reconcile', {}, { v: 2 }), 'invalid-envelope'],
    ['missing id', { v: 1, type: 'c/reconcile', payload: {} }, 'invalid-envelope'],
    ['bad id', envelope('c/reconcile', {}, { id: 'x'.repeat(65) }), 'invalid-envelope'],
    ['extra envelope key', envelope('c/reconcile', {}, { from: 'popup' }), 'invalid-envelope'],
    ['not an object', 'c/reconcile', 'invalid-envelope'],
    ['null', null, 'invalid-envelope'],
  ])('%s', (_name, raw, code) => {
    expect(parseMessage(raw, POPUP, RUNTIME_ID)).toMatchObject({ ok: false, errors: { code } });
  });

  test.each([
    ['c/setSiteLevel', { hostname: 'News.Test', level: 'off' }],
    ['c/setSiteLevel', { hostname: 'news.test', level: 'max' }],
    ['c/setSiteLevel', { hostname: `${'a'.repeat(250)}.test`, level: 'off' }],
    ['c/pauseSite', { hostname: 'news.test', minutes: 45 }],
    ['c/setDefaultLevel', { level: 'off' }],
    ['c/setPack', { pack: 'Bad Pack', enabled: true }],
    ['c/setPack', { pack: 'cookies', enabled: 'yes' }],
    ['c/startPicker', { tabId: -1, mode: 'zap' }],
    ['c/startPicker', { tabId: 1.5, mode: 'zap' }],
    ['c/saveUserFilter', { hostname: 'news.test', selector: 'a{color:red}', nonce: 'n0nce-0123456789ab' }],
    ['c/saveUserFilter', { hostname: 'news.test', selector: 'x'.repeat(1_025), nonce: 'n0nce-0123456789ab' }],
    ['c/saveUserFilter', { hostname: 'news.test', selector: '.a', nonce: 'short' }],
    ['c/importBackup', { json: 'x'.repeat(MAX_BACKUP_BYTES + 1), expect: 'ab'.repeat(32) }],
    ['c/importBackup', { json: '{}' }],
    ['c/importBackup', { json: '{}', expect: 'XYZ' }],
    ['c/importBackup', { json: 'é'.repeat(MAX_BACKUP_BYTES / 2 + 1), expect: 'ab'.repeat(32) }],
    ['c/setSitePopupPolicy', { hostname: 'news.test', policy: 'smart' }],
    ['c/reconcile', { force: true }],
    ['c/setGpc', {}],
  ])('%s with %j', (type, payload) => {
    expect(parseMessage(envelope(type, payload), POPUP, RUNTIME_ID)).toMatchObject({ ok: false, errors: { code: 'invalid-payload' } });
  });
});

describe('parseMessage: fuzz', () => {
  const senderArb = fc.record(
    {
      id: fc.oneof(fc.constant(RUNTIME_ID), fc.string()),
      url: fc.oneof(fc.webUrl(), fc.constant(`${EXT}/popup.html`), fc.string()),
      origin: fc.oneof(fc.webUrl(), fc.constant(EXT)),
      tab: fc.record({ id: fc.integer() }),
      frameId: fc.integer(),
    },
    { requiredKeys: [] },
  );

  test('never throws on any input', () => {
    fc.assert(
      fc.property(fc.anything(), senderArb, (raw, sender) => {
        parseMessage(raw, sender, RUNTIME_ID);
      }),
    );
  });

  test('random envelopes of known types never pass from a content-script sender', () => {
    const typeArb = fc.constantFrom(...MESSAGE_TYPES.filter((t) => !isContentScriptMessage(t)));
    fc.assert(
      fc.property(typeArb, fc.anything(), fc.webUrl(), (type, payload, url) => {
        const sender: SenderInfo = { id: RUNTIME_ID, url, origin: new URL(url).origin, tab: { id: 1 }, frameId: 0 };
        expect(parseMessage(envelope(type, payload), sender, RUNTIME_ID).ok).toBe(false);
      }),
    );
  });

  test('accepted payloads are new objects with no extra keys', () => {
    const raw = { hostname: 'news.test', level: 'off' };
    const result = parseMessage(envelope('c/setSiteLevel', raw), POPUP, RUNTIME_ID);
    expect(result.ok && result.value.payload).toEqual(raw);
    expect(result.ok && result.value.payload).not.toBe(raw);
  });
});
