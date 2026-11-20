/**
 * State glyphs (UI notes §11): each state has its own shape, never only its own colour (WCAG 1.4.1).
 * Decorative: the text next to the icon carries the meaning, so the icon is hidden from assistive tech.
 */
import type { JSX } from 'preact';

export type IconName = 'on' | 'off' | 'paused' | 'reduced' | 'warning' | 'unavailable' | 'pending';

const VIEWBOX = '0 0 16 16';
const SIZE = 16;

const SHAPES: Readonly<Record<IconName, () => JSX.Element>> = {
  // Filled disc with a check: protected.
  on: () => (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M4.5 8.2l2.3 2.3 4.7-4.9" fill="none" stroke="var(--color-bg)" stroke-width="1.8" />
    </>
  ),
  // Ring with a slash: off.
  off: () => (
    <>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M3.6 12.4l8.8-8.8" stroke="currentColor" stroke-width="1.6" />
    </>
  ),
  // Ring with two bars: paused.
  paused: () => (
    <>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M6.3 5v6M9.7 5v6" stroke="currentColor" stroke-width="1.6" />
    </>
  ),
  // Half-filled disc: reduced (Light only).
  reduced: () => (
    <>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M8 1.8a6.2 6.2 0 0 0 0 12.4z" fill="currentColor" />
    </>
  ),
  // Triangle with a bar and a dot: needs attention.
  warning: () => (
    <>
      <path d="M8 1.5l7 12.5H1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      <path d="M8 6v4" stroke="currentColor" stroke-width="1.6" />
      <circle cx="8" cy="12" r="0.9" fill="currentColor" />
    </>
  ),
  // Ring with a horizontal bar: not available here.
  unavailable: () => (
    <>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M4.8 8h6.4" stroke="currentColor" stroke-width="1.6" />
    </>
  ),
  // Ring with clock hands: setting up.
  pending: () => (
    <>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6" />
      <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.6" />
    </>
  ),
};

export function Icon({ name, class: className }: { readonly name: IconName; readonly class?: string | undefined }): JSX.Element {
  return (
    <svg class={className} width={SIZE} height={SIZE} viewBox={VIEWBOX} aria-hidden="true" focusable="false" data-icon={name}>
      {SHAPES[name]()}
    </svg>
  );
}
