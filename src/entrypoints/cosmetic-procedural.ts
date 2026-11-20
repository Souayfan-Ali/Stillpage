import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { runProcedural } from '../content/cosmetic-procedural/glue.js';

// A WXT unlisted script (S-01, D-14): ISOLATED world, `document_start`, listed right after uBO's
// procedural engine in the registrations of hosts with procedural filters (P1-36).
export default defineUnlistedScript(() => {
  runProcedural({
    scope: self,
    document,
    location,
    clock: { now: () => performance.now(), frame: (cb) => requestAnimationFrame(cb), timeout: (cb, ms) => setTimeout(cb, ms) },
    newObserver: (cb) => new MutationObserver(cb),
    newSheet: () => new CSSStyleSheet(),
  });
});
