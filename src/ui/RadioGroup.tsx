/**
 * Native radio group (P1-39, UI notes §9, ADR-015): a `fieldset` with a visible `legend`, one native
 * `input type=radio` per option with its own `label`. Arrow keys, Tab and screen readers work as for
 * any radio group; no custom slider (uBOL #654). The description of the chosen option is linked to
 * the group with `aria-describedby` (read once on entering it, never attached to another option).
 * The checked option also carries a check mark, so selection is not shown by colour alone. P3-18: an option
 * may carry a decorative glyph and a hue (its own colour, tinted when free and filled when checked).
 */
import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Glyph, type GlyphName } from './Glyph.js';
import styles from './RadioGroup.module.css';

/** An option's own colour (tokens.css `--color-level-*`). */
type RadioHue = 'light' | 'standard' | 'thorough';

export interface RadioOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly glyph?: GlyphName;
  readonly hue?: RadioHue;
}

export interface RadioGroupProps<T extends string> {
  readonly name: string;
  readonly legend: string;
  readonly options: readonly RadioOption<T>[];
  /** The checked value; `null` checks none. */
  readonly value: T | null;
  readonly onChange: (value: T) => void;
  /** Shown under the group; describes the checked option. */
  readonly description?: string;
  /** Extra note under the description (e.g. why a choice has no effect). */
  readonly note?: string;
  readonly disabled?: boolean;
}

interface OptionProps<T extends string> {
  readonly option: RadioOption<T>;
  readonly id: string;
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: (value: T) => void;
}

function Option<T extends string>({ option, id, name, checked, onChange }: OptionProps<T>): JSX.Element {
  return (
    <div class={styles['option']} data-hue={option.hue}>
      <input
        class={styles['input']}
        type="radio"
        id={id}
        name={name}
        value={option.value}
        checked={checked}
        onChange={() => {
          onChange(option.value);
        }}
      />
      <label class={styles['label']} for={id}>
        {option.glyph === undefined ? null : <Glyph name={option.glyph} />}
        {option.label}
      </label>
    </div>
  );
}

export function RadioGroup<T extends string>(props: RadioGroupProps<T>): JSX.Element {
  const { name, legend, options, value, onChange, description, note, disabled = false } = props;
  const base = useId();
  const descriptionId = `${base}-description`;
  const noteId = `${base}-note`;
  const describedBy = [description === undefined ? null : descriptionId, note === undefined ? null : noteId].filter((id) => id !== null).join(' ');
  return (
    <fieldset class={styles['group']} disabled={disabled} aria-describedby={describedBy === '' ? undefined : describedBy}>
      <legend class={styles['legend']}>{legend}</legend>
      <div class={styles['track']}>
        <div class={styles['options']}>
          {options.map((option) => (
            <Option key={option.value} option={option} id={`${base}-${option.value}`} name={name} checked={option.value === value} onChange={onChange} />
          ))}
        </div>
      </div>
      {description === undefined ? null : (
        <p class={styles['description']} id={descriptionId}>
          {description}
        </p>
      )}
      {note === undefined ? null : (
        <p class={styles['note']} id={noteId}>
          {note}
        </p>
      )}
    </fieldset>
  );
}
