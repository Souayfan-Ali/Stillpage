/**
 * The logo's mark (P3-16, store/logo/glassmere-logo.png): a rounded page with a folded corner and two still
 * waves. Drawn inline in the token colours (the page in `currentColor`, the fold and the upper wave in the
 * background colour, the lower wave in `--color-brand-wave`), so it follows light, dark and the theme
 * setting with no image request. Decorative: the product name next to it carries the meaning.
 */
import type { JSX } from 'preact';

const DEFAULT_SIZE = 24;

export function BrandMark({ size = DEFAULT_SIZE, class: className }: { readonly size?: number; readonly class?: string | undefined }): JSX.Element {
  return (
    <svg class={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" data-brand-mark="">
      <path d="M9 3h12l8 8v12a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V9a6 6 0 0 1 6-6z" fill="currentColor" />
      <path d="M21.6 4.6v4.6a1.6 1.6 0 0 0 1.6 1.6h4.6z" fill="var(--color-bg)" />
      <path d="M6 18.4c4-1.2 7.6-1 11 0s6.4.8 9-.2" fill="none" stroke="var(--color-bg)" stroke-width="1.6" stroke-linecap="round" />
      <path d="M10 22.4c2.4-.9 4.6-.2 6.6.3s4.2.1 5.6-.4" fill="none" stroke="var(--color-brand-wave)" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  );
}
