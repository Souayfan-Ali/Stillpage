/** Short spoken description of the highlighted element (P2-18, a11y): `article.card, 300 × 250`. */
import { classesOf, idOf, tagNameOf } from './dom.js';

export function describeElement(el: Element, rect: Pick<DOMRect, 'width' | 'height'>): string {
  const tag = tagNameOf(el).toLowerCase();
  const first = classesOf(el)[0];
  const id = idOf(el);
  const name = id !== '' ? `${tag}#${id}` : first !== undefined ? `${tag}.${first}` : tag;
  return `${name}, ${String(Math.round(rect.width))} × ${String(Math.round(rect.height))}`;
}
