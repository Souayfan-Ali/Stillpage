import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { STRICT_FLAG } from '../content/popup-sentinel/strict.js';

// `popup-strict` (pop-up notes §7.6): a one-line flag the sentinel reads at decision time, registered on the
// Strict sites before `popup-sentinel` runs its first judgement.
export default defineUnlistedScript(() => {
  (self as unknown as Record<symbol, unknown>)[STRICT_FLAG] = true;
});
