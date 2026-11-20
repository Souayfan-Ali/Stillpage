import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { QUIET_FLAG } from '../content/popup-sentinel/strict.js';

// `popup-quiet` (P2-59, design review): a one-line flag the sentinel reads when it would draw the notice, registered
// wherever the sentinel runs while "Tell me when a pop-up is blocked" is off. Blocking and the log are unchanged.
export default defineUnlistedScript(() => {
  (self as unknown as Record<symbol, unknown>)[QUIET_FLAG] = true;
});
