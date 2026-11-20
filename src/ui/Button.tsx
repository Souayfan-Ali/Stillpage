/** Native button (P1-39, UI notes §9): reachable and operable by keyboard; ≥ 24 px target, primary ≥ 32 px. */
import type { ComponentChildren, JSX } from 'preact';
import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'quiet';

export interface ButtonProps {
  readonly onClick: () => void;
  readonly children: ComponentChildren;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /** Id of an element that explains what the button does. */
  readonly describedBy?: string;
  /** Accessible name when the visible text alone is ambiguous; it must start with that text (WCAG 2.5.3). */
  readonly label?: string;
  /** A toggle button's state (`aria-pressed`); its name stays the same in both states. */
  readonly pressed?: boolean;
}

export function Button({ onClick, children, variant = 'secondary', disabled = false, describedBy, label, pressed }: ButtonProps): JSX.Element {
  return (
    <button type="button" class={`${styles['button'] ?? ''} ${styles[variant] ?? ''}`} onClick={onClick} disabled={disabled} aria-describedby={describedBy} aria-label={label} aria-pressed={pressed}>
      {children}
    </button>
  );
}
