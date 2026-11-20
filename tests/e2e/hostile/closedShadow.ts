/**
 * Finding a button inside one of our closed shadow roots from the test (the page cannot): CDP's DOM
 * domain pierces closed roots. Used to aim a real (trusted) mouse click at the notice's buttons.
 */
import type { Page } from '@playwright/test';

interface DomNode {
  readonly nodeId: number;
  readonly nodeName: string;
  readonly nodeValue?: string;
  readonly children?: readonly DomNode[];
  readonly shadowRoots?: readonly DomNode[];
  readonly contentDocument?: DomNode;
}

const textOf = (n: DomNode): string => (n.nodeName === '#text' ? n.nodeValue ?? '' : [...(n.children ?? [])].map(textOf).join(''));

function find(n: DomNode, label: string): DomNode | undefined {
  if (n.nodeName === 'BUTTON' && textOf(n) === label) return n;
  for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
    const hit = find(c, label);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export interface Point { readonly x: number; readonly y: number }

/** The centre of the first button labelled `label` in the page, closed shadow roots included; `null` when absent. */
export async function buttonCentre(tab: Page, label: string): Promise<Point | null> {
  const cdp = await tab.context().newCDPSession(tab);
  try {
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: DomNode };
    const button = find(root, label);
    if (button === undefined) return null;
    const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: button.nodeId })) as { model: { content: readonly number[] } };
    const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
    return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
  } finally {
    await cdp.detach();
  }
}
