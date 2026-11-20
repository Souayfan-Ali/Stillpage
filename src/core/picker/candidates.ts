/**
 * Selector candidate generator (P2-17, cosmetic notes §9, UI notes §5). From the picked element it builds
 * candidates in four families: its id, attribute anchors (`data-*`, `aria-label`, `title`, `alt`,
 * `name`, `role`, the origin of a link or frame address), its stable classes (with and without the
 * tag, and under an anchored ancestor) and a structural `nth-of-type` path as the fallback. Names
 * that look generated (`isHashedLike`) are penalised, never trusted more than structure. Pure: the
 * content script checks each candidate with `querySelectorAll` through `rankCandidates`.
 */
import { cssAttributeValue, cssIdent, isHashedLike } from './ident.js';
import type { Candidate, CandidateKind, PickerNode } from './types.js';

/** Base scores per family; a generated-looking name costs `HASHED_PENALTY`. */
const SCORE = { id: 100, attribute: 80, tagClass: 75, classes: 72, class: 70, ancestor: 55, structural: 30 } as const;
const HASHED_PENALTY = 45;
/** Attributes whose whole value is a usable anchor. */
const VALUE_ATTRIBUTES = ['aria-label', 'title', 'alt', 'name', 'role'] as const;
/** Elements anchored by the origin of their address (`a[href^="https://ads.example/"]`). */
const ADDRESS_ATTRIBUTE: Readonly<Record<string, string>> = { a: 'href', iframe: 'src', img: 'src', embed: 'src' };
/** How far up the generator looks for an anchored ancestor. */
const MAX_ANCESTOR_DEPTH = 6;
/** Longest structural path; a deeper (or cyclic, clobbered) chain gives no structural candidate. */
const MAX_PATH_STEPS = 50;
/** Most attribute candidates taken from one element. */
const MAX_ATTRIBUTE_CANDIDATES = 6;

const candidate = (selector: string, kind: CandidateKind, base: number, hashed: boolean): Candidate =>
  ({ selector, kind, score: base - (hashed ? HASHED_PENALTY : 0) });

const tagOf = (node: PickerNode): string | null => cssIdent(node.tagName.toLowerCase());

/** Usable classes, escaped, with whether each looks generated. */
function classesOf(node: PickerNode): readonly { readonly ident: string; readonly hashed: boolean }[] {
  return [...new Set(node.classList)].flatMap((token) => {
    const ident = cssIdent(token);
    return ident === null ? [] : [{ ident, hashed: isHashedLike(token) }];
  });
}

/** `#id` of a node, or null when it has none or it cannot be written. */
const idOf = (node: PickerNode): { readonly ident: string; readonly hashed: boolean } | null => {
  const ident = node.id === '' ? null : cssIdent(node.id);
  return ident === null ? null : { ident, hashed: isHashedLike(node.id) };
};

function idCandidates(node: PickerNode): readonly Candidate[] {
  const id = idOf(node);
  return id === null ? [] : [candidate(`#${id.ident}`, 'id', SCORE.id, id.hashed)];
}

/** `https://host/` of an absolute http(s) address, or null. */
function originPrefix(address: string): string | null {
  if (!/^https?:\/\//i.test(address)) return null;
  try {
    return `${new URL(address).origin}/`;
  } catch {
    return null;
  }
}

function attributeCandidates(node: PickerNode, tag: string): readonly Candidate[] {
  const names = [...VALUE_ATTRIBUTES, ...node.getAttributeNames().filter((n) => /^data-[a-z0-9-]+$/.test(n)).sort()];
  const exact = names.flatMap((name) => {
    const value = node.getAttribute(name);
    const quoted = value === null ? null : cssAttributeValue(value);
    return value === null || quoted === null ? [] : [candidate(`${tag}[${name}=${quoted}]`, 'attribute', SCORE.attribute, isHashedLike(value))];
  });
  const addressName = ADDRESS_ATTRIBUTE[tag];
  const address = addressName === undefined ? null : node.getAttribute(addressName);
  const prefix = address === null ? null : originPrefix(address);
  const quotedPrefix = prefix === null ? null : cssAttributeValue(prefix);
  const byAddress = quotedPrefix === null || addressName === undefined ? [] : [candidate(`${tag}[${addressName}^=${quotedPrefix}]`, 'attribute', SCORE.attribute, false)];
  return [...byAddress, ...exact].slice(0, MAX_ATTRIBUTE_CANDIDATES);
}

function classCandidates(node: PickerNode, tag: string): readonly Candidate[] {
  const classes = classesOf(node);
  const stable = classes.filter((c) => !c.hashed);
  const all = stable.length > 1 ? [candidate(`${tag}${stable.map((c) => `.${c.ident}`).join('')}`, 'class', SCORE.classes, false)] : [];
  return [
    ...classes.map((c) => candidate(`${tag}.${c.ident}`, 'class', SCORE.tagClass, c.hashed)),
    ...all,
    ...classes.map((c) => candidate(`.${c.ident}`, 'class', SCORE.class, c.hashed)),
  ];
}

/** `#id` or the first stable `.class` of a node, when it has one that is not generated-looking. */
function anchorOf(node: PickerNode): string | null {
  const id = idOf(node);
  if (id !== null && !id.hashed) return `#${id.ident}`;
  const cls = classesOf(node).find((c) => !c.hashed);
  return cls === undefined ? null : `.${cls.ident}`;
}

function ancestorsOf(node: PickerNode): readonly PickerNode[] {
  const out: PickerNode[] = [];
  for (let p = node.parentElement; p !== null && out.length < MAX_ANCESTOR_DEPTH; p = p.parentElement) out.push(p);
  return out;
}

/** `.list .item`: the element's first stable class under the nearest anchored ancestor. */
function ancestorCandidates(node: PickerNode): readonly Candidate[] {
  const own = classesOf(node).find((c) => !c.hashed);
  const anchor = ancestorsOf(node).map(anchorOf).find((a): a is string => a !== null);
  return own === undefined || anchor === undefined ? [] : [candidate(`${anchor} .${own.ident}`, 'ancestor', SCORE.ancestor, false)];
}

/** `tag` or `tag:nth-of-type(n)` when siblings share the tag. */
function stepOf(node: PickerNode, tag: string): string {
  const siblings = node.parentElement === null ? [] : Array.from(node.parentElement.children).filter((s) => s.tagName === node.tagName);
  return siblings.length <= 1 ? tag : `${tag}:nth-of-type(${String(siblings.indexOf(node) + 1)})`;
}

/** `#feed > div > span:nth-of-type(2)`, from the nearest stable id, else from `body`. */
function structuralCandidate(node: PickerNode): readonly Candidate[] {
  const steps: string[] = [];
  for (let n: PickerNode | null = node; n !== null && steps.length <= MAX_PATH_STEPS; n = n.parentElement) {
    const id = idOf(n);
    if (n !== node && id !== null && !id.hashed) return [candidate([`#${id.ident}`, ...steps].join(' > '), 'structural', SCORE.structural, false)];
    const tag = tagOf(n);
    if (tag === null) return [];
    if (tag === 'body' || tag === 'html') return [candidate([tag, ...steps].join(' > '), 'structural', SCORE.structural, false)];
    steps.unshift(stepOf(n, tag));
  }
  return [];
}

/** Every candidate for `node`, unchecked and unsorted (`rankCandidates` checks and orders them). */
export function generateCandidates(node: PickerNode): readonly Candidate[] {
  const tag = tagOf(node);
  if (tag === null) return [];
  return [
    ...idCandidates(node),
    ...attributeCandidates(node, tag),
    ...classCandidates(node, tag),
    ...ancestorCandidates(node),
    ...structuralCandidate(node),
  ];
}
