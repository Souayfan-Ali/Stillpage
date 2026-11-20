/**
 * Clobber-proof DOM reads for the picker (security review MEDIUM-2, P2-18/P2-19). `document` and
 * `<form>` have named-property getters that win over built-ins in every world: `<img name=createElement>`
 * makes `document.createElement` an element, `<form><input name=parentElement>` makes
 * `form.parentElement` its input (a loop). Every read the picker makes on page nodes goes through the
 * prototype getters and methods captured here when the script loads, before it touches the page.
 */
import type { PickerNode } from '../../core/picker/types.js';

type Native = (self: unknown, ...args: readonly unknown[]) => unknown;

function wrap(fn: unknown, name: string): Native {
  if (typeof fn !== 'function') throw new Error(`no native ${name}`);
  const native = fn as (...args: unknown[]) => unknown;
  return (self, ...args) => Reflect.apply(native, self, args);
}

/** A native getter, called with an explicit receiver. */
function getter(proto: object, name: string): Native {
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  return wrap(desc === undefined ? undefined : Reflect.get(desc, 'get'), name);
}

/** A native method, called with an explicit receiver: `method(proto, 'x')(el, ...args)`. */
function method(proto: object, name: string | symbol): Native {
  const desc = Object.getOwnPropertyDescriptor(proto, name);
  return wrap(desc === undefined ? undefined : Reflect.get(desc, 'value'), String(name));
}

/** `elementsFromPoint` may be missing (jsdom); then nothing is under the pointer. */
const nativeElementsFromPoint = Object.hasOwn(Document.prototype, 'elementsFromPoint') ? method(Document.prototype, 'elementsFromPoint') : null;

const N = {
  tagName: getter(Element.prototype, 'tagName'),
  id: getter(Element.prototype, 'id'),
  classList: getter(Element.prototype, 'classList'),
  children: getter(Element.prototype, 'children'),
  parentElement: getter(Node.prototype, 'parentElement'),
  next: getter(Element.prototype, 'nextElementSibling'),
  prev: getter(Element.prototype, 'previousElementSibling'),
  isConnected: getter(Node.prototype, 'isConnected'),
  baseURI: getter(Node.prototype, 'baseURI'),
  documentElement: getter(Document.prototype, 'documentElement'),
  body: getter(Document.prototype, 'body'),
  activeElement: getter(Document.prototype, 'activeElement'),
  rect: method(Element.prototype, 'getBoundingClientRect'),
  getAttribute: method(Element.prototype, 'getAttribute'),
  getAttributeNames: method(Element.prototype, 'getAttributeNames'),
  createElement: method(Document.prototype, 'createElement'),
  querySelectorAll: method(Document.prototype, 'querySelectorAll'),
  querySelector: method(Document.prototype, 'querySelector'),
  tokens: method(DOMTokenList.prototype, Symbol.iterator),
};

export const tagNameOf = (el: Element): string => N.tagName(el) as string;
export const idOf = (el: Element): string => N.id(el) as string;
export const classesOf = (el: Element): readonly string[] => [...{ [Symbol.iterator]: () => N.tokens(N.classList(el)) as Iterator<string> }];
export const parentOf = (el: Element): Element | null => N.parentElement(el) as Element | null;
export const childrenOf = (el: Element): readonly Element[] => Array.from(N.children(el) as HTMLCollection);
export const nextSiblingOf = (el: Element): Element | null => N.next(el) as Element | null;
export const previousSiblingOf = (el: Element): Element | null => N.prev(el) as Element | null;
export const isConnected = (node: Node): boolean => N.isConnected(node) === true;
export const attributeOf = (el: Element, name: string): string | null => N.getAttribute(el, name) as string | null;
export const baseOf = (doc: Document): string => N.baseURI(doc) as string;
export const rectOf = (el: Element): DOMRect => N.rect(el) as DOMRect;
export const rootOf = (doc: Document): Element | null => N.documentElement(doc) as Element | null;
export const bodyOf = (doc: Document): HTMLElement | null => N.body(doc) as HTMLElement | null;
export const activeOf = (doc: Document): Element | null => N.activeElement(doc) as Element | null;
export const createElementIn = (doc: Document, tag: string): HTMLElement => N.createElement(doc, tag) as HTMLElement;
export const queryAll = (doc: Document, selector: string): readonly Element[] => Array.from(N.querySelectorAll(doc, selector) as NodeListOf<Element>);
export const queryOne = (doc: Document, selector: string): Element | null => N.querySelector(doc, selector) as Element | null;
export const elementsAt = (doc: Document, x: number, y: number): readonly Element[] => (nativeElementsFromPoint?.(doc, x, y) as Element[] | undefined) ?? [];

const views = new WeakMap<Element, PickerNode>();

/** A `PickerNode` view of `el` that reads through the native getters only (one view per element). */
export function safeNode(el: Element): PickerNode {
  const known = views.get(el);
  if (known !== undefined) return known;
  const view: PickerNode = {
    get tagName() { return tagNameOf(el); },
    get id() { return idOf(el); },
    get classList() { return classesOf(el); },
    get parentElement() { const p = parentOf(el); return p === null ? null : safeNode(p); },
    get children() { return childrenOf(el).map(safeNode); },
    getAttribute: (name) => attributeOf(el, name),
    getAttributeNames: () => N.getAttributeNames(el) as string[],
  };
  views.set(el, view);
  return view;
}
