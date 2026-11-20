/**
 * The per-site level control (P1-41, ADR-015): Light / Standard / Thorough as a native radio group. P3-18:
 * each level in its own colour with the logo's waves, one per step (one, two, three).
 */
import type { JSX } from 'preact';
import { RadioGroup, type RadioOption } from '../../ui/RadioGroup.js';
import type { ChoosableLevel } from './store.js';
import { LEVEL_DESCRIPTIONS, LEVEL_NAMES, STRINGS } from './strings.js';
import type { TabState } from '../../core/messaging/tabState.js';

const CHOOSABLE: readonly ChoosableLevel[] = ['light', 'standard', 'thorough'];
const OPTIONS: readonly RadioOption<ChoosableLevel>[] = CHOOSABLE.map((value) => ({
  value,
  label: LEVEL_NAMES[value],
  glyph: value,
  hue: value,
}));

const isChoosable = (level: TabState['level']): level is ChoosableLevel => level !== 'off';

export interface LevelSelectorProps {
  readonly state: TabState;
  readonly onChoose: (level: ChoosableLevel) => void;
}

export function LevelSelector({ state, onChoose }: LevelSelectorProps): JSX.Element {
  const value = isChoosable(state.level) ? state.level : null;
  const capped = state.host === null ? STRINGS.noHostLevels : state.setOn !== null && state.setOn !== state.host ? STRINGS.capped(state.setOn) : undefined;
  return (
    <RadioGroup
      name="level"
      legend={STRINGS.levelLegend}
      options={OPTIONS}
      value={value}
      onChange={onChoose}
      disabled={state.host === null}
      {...(value === null ? {} : { description: LEVEL_DESCRIPTIONS[value] })}
      {...(capped === undefined ? {} : { note: capped })}
    />
  );
}
