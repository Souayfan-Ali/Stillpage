import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createNotice, visibilityWatch } from '../content/popup-sentinel/notice.js';
import { startSentinel } from '../content/popup-sentinel/sentinel.js';
import { QUIET_FLAG, STRICT_FLAG } from '../content/popup-sentinel/strict.js';
import { noticeText as say, onExtensionQuery, openFromNotice } from '../platform/sentinelPorts.js';

// `popup-sentinel` (P2-57): registered by the worker for top-level documents only, ISOLATED world,
// `document_start`, so its capture listeners exist before any page script.
export default defineUnlistedScript(() => {
  const now = (): number => performance.timeOrigin + performance.now();
  const notice = createNotice(document, now, (run, ms) => {
    const id = setTimeout(run, ms);
    return () => { clearTimeout(id); };
  }, visibilityWatch(window, now), say);
  const flag = (key: symbol): boolean => (self as unknown as Record<symbol, unknown>)[key] === true;
  // 128 random bits; the event name the shim's `window.open` requests use (P2-58).
  const secret = `x${Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(36)).join('')}`;
  let armed = false;
  const sentinel = startSentinel({
    window, view: window, notice, now,
    strict: () => flag(STRICT_FLAG),
    quiet: () => flag(QUIET_FLAG),
    open: openFromNotice,
    secret,
    say,
    // The extension-message listener waits for the first event the judge reads (guard cost, D-42b).
    arm: () => {
      if (!armed) onExtensionQuery((message) => sentinel.answer(message));
      armed = true;
    },
  });
});
