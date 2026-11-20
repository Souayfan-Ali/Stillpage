/**
 * "Show on page" (P2-22b, D-50): the packaged function the toolbar panel injects into the tab's top frame
 * with `scripting.executeScript({ func, args })`. Chrome injects it by its source text, so it must stay
 * self-contained: no imports, no module-level bindings, every constant inside. The selector is a JSON
 * argument (data, never code); it is checked here again (the page is a boundary) and only ever handed to
 * `querySelectorAll`.
 *
 * It only un-hides and outlines: inline `display: revert` and an outline, all `!important` (an inline
 * `!important` beats the hiding sheet). It writes nothing that stays: each changed property's previous
 * value and priority is restored exactly, a `style` attribute it added is removed, and its one handle,
 * a property of the extension's isolated world (never visible to the page), is deleted on revert. It
 * reverts on its timer, or when called with `null` (the panel closed or showed another item). One
 * preview at a time. The page can watch the change while it lasts; nothing is left afterwards.
 *
 * P2-43 security review: it acts only on a page of the panel's host (`host`), so a tab that navigated to
 * another site while the panel was open never learns which selectors the user hid elsewhere; and every
 * attribute and style call goes through the prototypes (or the style object kept at the start), so a
 * page's `<form>` whose inputs shadow `setAttribute` or `style` cannot leave the outline behind.
 */

export type ShowResult = { readonly shown: number } | { readonly error: 'invalid' };

interface Saved {
  readonly el: Element;
  readonly style: CSSStyleDeclaration;
  /** The `style` attribute as the page wrote it (`null`: none). */
  readonly text: string | null;
  readonly before: readonly (readonly [string, string, string])[];
}

export function showOnPage(selector: unknown, durationMs: unknown, host?: unknown): ShowResult {
  const KEY = Symbol.for('show-on-page.preview');
  const MAX_SELECTOR_LENGTH = 1_024;
  const MAX_MS = 60_000;
  const MAX_ELEMENTS = 200;
  const SHOWN: readonly (readonly [string, string])[] = [['display', 'revert'], ['outline-style', 'solid'], ['outline-width', '3px'], ['outline-color', '#c2410c'], ['outline-offset', '2px']];
  const world = globalThis as unknown as Record<symbol, { readonly revert: () => void } | undefined>;
  world[KEY]?.revert();
  if (selector === null) return { shown: 0 };
  const validMs = typeof durationMs === 'number' && Number.isInteger(durationMs) && durationMs > 0 && durationMs <= MAX_MS;
  const here = location.hostname.toLowerCase().replace(/\.$/, '');
  if (typeof selector !== 'string' || selector === '' || selector.length > MAX_SELECTOR_LENGTH || !validMs || host !== here) return { error: 'invalid' };
  const styleText = (el: Element): string | null => Element.prototype.getAttribute.call(el, 'style');
  let found: readonly Element[];
  try {
    found = Array.from(document.querySelectorAll(selector)).slice(0, MAX_ELEMENTS);
  } catch {
    return { error: 'invalid' };
  }
  const saved: readonly Saved[] = found.flatMap((el) => {
    const style: unknown = 'style' in el ? el.style : null;
    if (!(style instanceof CSSStyleDeclaration)) return [];
    return [{ el, style, text: styleText(el), before: SHOWN.map(([name]) => [name, style.getPropertyValue(name), style.getPropertyPriority(name)] as const) }];
  });
  if (saved.length === 0) return { shown: 0 };
  for (const { style } of saved) for (const [name, value] of SHOWN) style.setProperty(name, value, 'important');
  const shownText = saved.map(({ el }) => styleText(el));
  /** The page's own text back, byte for byte; if the page changed the style meanwhile, only our properties. */
  const restore = ({ el, style, text, before }: Saved, index: number): void => {
    if (styleText(el) === shownText[index]) {
      if (text === null) Element.prototype.removeAttribute.call(el, 'style');
      else Element.prototype.setAttribute.call(el, 'style', text);
      return;
    }
    for (const [name, value, priority] of before) {
      if (value === '') style.removeProperty(name);
      else style.setProperty(name, value, priority);
    }
  };
  const entry = {
    revert: (): void => {
      clearTimeout(timer);
      try {
        saved.forEach(restore);
      } finally {
        if (world[KEY] === entry) Reflect.deleteProperty(world, KEY);
      }
    },
  };
  const timer = setTimeout(entry.revert, durationMs);
  world[KEY] = entry;
  const first = saved[0]?.el;
  const box = first?.getBoundingClientRect();
  if (first !== undefined && box !== undefined && (box.bottom < 0 || box.top > innerHeight)) {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    first.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }
  return { shown: saved.length };
}
