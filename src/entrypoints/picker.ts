import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { runPicker } from '../content/picker/controller.js';
import { elementsAt, queryAll } from '../content/picker/dom.js';
import { acceptStart } from '../content/picker/start.js';
import { pickerRuntime } from '../platform/picker.js';

/** Isolated-world flag (not visible to the page): a second injection adds no second listener. */
const INJECTED = Symbol.for('picker.injected');

// A WXT unlisted script injected on demand by the worker (`scripting.executeScript`, ISOLATED world,
// top frame; P2-18/P2-19, cosmetic notes §9). It waits for the worker's `x/pickerStart` and runs one picker
// at a time. It never sends a save: the panel does (design review).
export default defineUnlistedScript(() => {
  const scope = self as unknown as Record<symbol, boolean | undefined>;
  if (scope[INJECTED] === true) return;
  scope[INJECTED] = true;
  const runtime = pickerRuntime();
  let active = false;
  runtime.onMessage((message, sender) => {
    const start = acceptStart(message, sender, runtime.id);
    if (start === null || active) return;
    active = true;
    runPicker({
      document, window,
      elementsFromPoint: (x, y) => elementsAt(document, x, y),
      query: (selector) => queryAll(document, selector),
      setTimer: (run, ms) => {
        const id = setTimeout(run, ms);
        return () => { clearTimeout(id); };
      },
      newSheet: () => new CSSStyleSheet(),
      panelUrl: runtime.panelUrl,
      panelOrigin: runtime.panelOrigin,
      labels: runtime.labels,
      onEnd: () => { active = false; },
    }, start.nonce, start.hint);
  });
});
