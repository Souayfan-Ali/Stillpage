import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { runGenericSurvey, type SurveyDom } from '../content/cosmetic-generic/survey.js';

type Method<A extends unknown[], R> = (this: Element, ...args: A) => R;

/** One of this world's own `Element.prototype` methods (never the element's own, page-shadowable property). */
function protoMethod<A extends unknown[], R>(name: string): Method<A, R> {
  return Object.getOwnPropertyDescriptor(Element.prototype, name)?.value as Method<A, R>;
}

/** Element reads through methods captured from this world's prototypes (DOM clobbering, P2-24 review). */
function domPort(): SurveyDom {
  const getAttribute = protoMethod<[string], string | null>('getAttribute');
  const querySelectorAll = protoMethod<[string], NodeListOf<Element>>('querySelectorAll');
  return {
    isElement: (node): node is object => node instanceof Element,
    attribute: (el, name) => getAttribute.call(el as Element, name),
    descendants: (el, selector) => querySelectorAll.call(el as Element, selector),
  };
}

// A WXT unlisted script (S-01, D-14): ISOLATED world, `document_idle`, registered by the worker on
// Thorough hosts after the enabled packs' `cosmetic/<pack>/generic.js` data files (P2-24, P2-25).
// Everything runs inside the callback: WXT imports this module in Node at build time.
export default defineUnlistedScript(() => {
  runGenericSurvey({
    scope: self,
    document,
    location,
    viewport: () => ({ width: innerWidth, height: innerHeight }),
    clock: { now: () => performance.now(), frame: (cb) => requestAnimationFrame(cb), timeout: (cb, ms) => setTimeout(cb, ms) },
    newObserver: (cb) => new MutationObserver(cb),
    newSheet: () => new CSSStyleSheet(),
    dom: domPort(),
  });
});
