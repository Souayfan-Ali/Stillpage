/**
 * Picker panel view (P2-19, UI notes §5): a focus-trapped dialog "Hide this?" with the count, "Bigger / Smaller
 * area" (D-81), the "Similar ones too?" slider (low end "only this" when the narrowest choice is one item, else
 * "fewer"; high end "more like it"), "Show the page without it", once / always, Cancel / Hide and a read-only
 * "Advanced: selector" (wording D-105; order unchanged since P3-17). No framework (small on-demand page);
 * every page-derived string is set with `textContent`.
 */
import type { ToastActions, ViewActions, ViewModel } from './panel.js';
import { plural, t } from '../../ui/i18n.js';
import type { VisibilityWatch } from './visibility.js';

/** How long "Hidden. Undo" stays (UI notes §5); paused while hovered or focused. */
export const TOAST_MS = 8_000;

/** Shown when a gated action is clicked while the page covers the panel (J15; design review). */
export const COVERED = t('picker_covered');

type Attrs = Readonly<Record<string, string>>;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Attrs = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Gates `button` on `watch`: it acts only while continuously visible; otherwise the `[data-covered]` line
 * says why. `aria-disabled` follows the raw visibility. Cancel and Escape are never gated.
 */
function gated(doc: Document, button: HTMLButtonElement, watch: VisibilityWatch, run: () => void): HTMLElement {
  const note = el(doc, 'p', { role: 'status', 'data-covered': '' });
  const visible = watch(button, (v) => { button.setAttribute('aria-disabled', String(!v)); });
  button.addEventListener('click', () => {
    if (!visible()) {
      note.textContent = COVERED;
      return;
    }
    note.textContent = '';
    run();
  });
  return note;
}

const elements = (n: number): string => plural(n, 'picker_elements_one', 'picker_elements_other');

/** The slider's low end: "only this" only when the narrowest choice hides exactly one item, else "fewer" (D-105). */
const lowEnd = (model: ViewModel): string => (model.candidates[0]?.count === 1 ? t('picker_only_this') : t('picker_fewer'));

function slider(doc: Document, model: ViewModel): { readonly row: HTMLElement; readonly input: HTMLInputElement; readonly low: HTMLElement } {
  const row = el(doc, 'div', { class: 'row slider' }); // i18n-exempt: CSS class names (D-110)
  const input = el(doc, 'input', { id: 'spread', type: 'range', min: '0', max: String(model.candidates.length - 1), step: '1' });
  input.value = String(model.index);
  const low = el(doc, 'span', { 'aria-hidden': 'true' });
  row.append(el(doc, 'label', { for: 'spread' }, t('picker_similar')), low, input, el(doc, 'span', { 'aria-hidden': 'true' }, t('picker_more')));
  return { row, input, low };
}

interface AreaControls {
  readonly group: HTMLElement;
  readonly note: HTMLElement;
  readonly set: (model: ViewModel) => void;
}

/**
 * "Bigger area" / "Smaller area" (D-81): real buttons before the slider; at a limit `aria-disabled` (still
 * focusable, so focus stays put); the large-area warning and the limit line in a status region.
 */
function areaControls(doc: Document, actions: ViewActions): AreaControls {
  const group = el(doc, 'div', { role: 'group', 'aria-labelledby': 'area-label', class: 'row', 'data-area-group': '' });
  const wider = el(doc, 'button', { type: 'button', 'data-widen': '' }, t('picker_bigger'));
  const narrower = el(doc, 'button', { type: 'button', 'data-narrow': '' }, t('picker_smaller'));
  group.append(el(doc, 'span', { id: 'area-label' }, t('picker_area')), wider, narrower);
  const note = el(doc, 'p', { role: 'status', 'data-area': '' });
  let can = { canWiden: false, canNarrow: false };
  wider.addEventListener('click', () => { if (can.canWiden) actions.widen(); });
  narrower.addEventListener('click', () => { if (can.canNarrow) actions.narrow(); });
  const set = (model: ViewModel): void => {
    can = model;
    wider.setAttribute('aria-disabled', String(!model.canWiden));
    narrower.setAttribute('aria-disabled', String(!model.canNarrow));
    note.textContent = [model.large ? t('picker_large') : '', model.canWiden ? '' : t('picker_biggest')].filter((x) => x !== '').join(' ');
  };
  return { group, note, set };
}

function choice(doc: Document, model: ViewModel): HTMLFieldSetElement {
  const set = el(doc, 'fieldset');
  set.append(el(doc, 'legend', {}, t('picker_how_long')));
  for (const [value, text] of [['once', t('picker_once')], ['always', t('picker_always', model.hostname)]] as const) {
    const radio = el(doc, 'input', { type: 'radio', name: 'duration', id: value, value });
    radio.checked = (value === 'always') === (model.mode === 'hide');
    const row = el(doc, 'div', { class: 'row' });
    row.append(radio, el(doc, 'label', { for: value }, text));
    set.append(row);
  }
  return set;
}

function trapFocus(doc: Document, dialog: HTMLElement, cancel: () => void): void {
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button, input, summary')];
    const [first, last] = [focusable[0], focusable.at(-1)];
    const wrapTo = e.shiftKey ? (doc.activeElement === first ? last : undefined) : (doc.activeElement === last ? first : undefined);
    if (wrapTo === undefined) return;
    e.preventDefault();
    wrapTo.focus();
  });
}

/** Builds the dialog into `doc.body` and wires it to `actions`; returns how to update it in place (D-81). */
export function renderPanel(doc: Document, model: ViewModel, actions: ViewActions, watch: VisibilityWatch): (next: ViewModel) => void {
  const dialog = el(doc, 'div', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'title' });
  const count = el(doc, 'p', { 'data-count': '', 'aria-live': 'polite' });
  const { row, input, low } = slider(doc, model);
  const area = areaControls(doc, actions);
  let current = model;
  const preview = el(doc, 'input', { type: 'checkbox', id: 'preview' });
  preview.checked = true;
  const previewRow = el(doc, 'div', { class: 'row' });
  previewRow.append(preview, el(doc, 'label', { for: 'preview' }, t('picker_preview')));
  const code = el(doc, 'code');
  const details = el(doc, 'details');
  details.append(el(doc, 'summary', {}, t('picker_show_selector')), code);
  const buttons = el(doc, 'div', { class: 'buttons' });
  const cancel = el(doc, 'button', { type: 'button', 'data-cancel': '' }, t('common_cancel'));
  const hide = el(doc, 'button', { type: 'button', 'data-hide': '', class: 'primary' }, t('picker_hide'));
  buttons.append(cancel, hide);
  const index = (): number => Number(input.value);
  const note = gated(doc, hide, watch, () => {
    const always = doc.querySelector<HTMLInputElement>('input[value="always"]')?.checked === true;
    if (always) void actions.hideAlways(index());
    else actions.hideOnce(index());
  });
  dialog.append(el(doc, 'h1', { id: 'title' }, t('picker_title')), count, area.group, area.note, row, previewRow, choice(doc, model),
    el(doc, 'p', { role: 'alert', 'data-error': '' }), note, buttons, details);

  const update = (): void => {
    const c = current.candidates[index()];
    low.textContent = lowEnd(current);
    count.textContent = plural(c?.count ?? 0, 'picker_count_one', 'picker_count_other');
    input.setAttribute('aria-valuetext', elements(c?.count ?? 0));
    code.textContent = c?.selector ?? '';
    actions.select(index(), preview.checked);
  };
  input.addEventListener('input', update);
  preview.addEventListener('change', update);
  cancel.addEventListener('click', () => { actions.cancel(); });
  trapFocus(doc, dialog, actions.cancel);
  doc.body.replaceChildren(dialog);
  area.set(model);
  update();
  input.focus();
  return (next) => {
    current = next;
    input.max = String(next.candidates.length - 1);
    input.value = String(next.index);
    area.set(next);
    update();
  };
}

/** Shows `text` in the dialog's alert region. */
export function showPanelError(doc: Document, text: string): void {
  const region = doc.querySelector('[data-error]');
  if (region !== null) region.textContent = text;
}

/** "Hidden. Undo" (P2-21, UI notes §5): replaces the dialog; times out unless hovered or focused. */
export function renderToast(doc: Document, actions: ToastActions, setTimer: (run: () => void, ms: number) => () => void, watch: VisibilityWatch): void {
  const box = el(doc, 'div', { role: 'status', class: 'toast' });
  const undo = el(doc, 'button', { type: 'button', class: 'primary' }, t('picker_undo'));
  const note = gated(doc, undo, watch, () => {
    cancel();
    undo.disabled = true;
    void actions.undo().finally(() => { undo.disabled = false; });
  });
  box.append(el(doc, 'span', {}, t('picker_hidden')), ' ', undo, el(doc, 'p', { role: 'alert', 'data-error': '' }), note);
  let cancel = setTimer(actions.expire, TOAST_MS);
  const pause = (): void => { cancel(); };
  const restart = (): void => {
    if (box.matches(':hover') || box.contains(doc.activeElement)) return;
    cancel();
    cancel = setTimer(actions.expire, TOAST_MS);
  };
  box.addEventListener('mouseenter', pause);
  box.addEventListener('focusin', pause);
  box.addEventListener('mouseleave', restart);
  box.addEventListener('focusout', restart);
  doc.body.replaceChildren(box);
  undo.focus();
}
