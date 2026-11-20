// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Banner } from '../../../src/ui/Banner.js';
import { BrandMark } from '../../../src/ui/BrandMark.js';
import { Button } from '../../../src/ui/Button.js';
import { Glyph, GLYPH_NAMES } from '../../../src/ui/Glyph.js';
import { Icon, type IconName } from '../../../src/ui/Icon.js';
import { RadioGroup } from '../../../src/ui/RadioGroup.js';
import { axeViolations } from './axe.js';

afterEach(cleanup);

const LEVELS = [
  { value: 'light', label: 'Light' },
  { value: 'standard', label: 'Standard' },
  { value: 'thorough', label: 'Thorough' },
] as const;

describe('Button', () => {
  test('is a native button that never submits, named by its text', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Allow on all sites</Button>);
    const button = screen.getByRole('button', { name: 'Allow on all sites' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a disabled button is natively disabled (browsers then send it no clicks)', () => {
    render(
      <Button onClick={() => undefined} disabled>
        Save
      </Button>,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  test('can be described by another element', () => {
    render(
      <>
        <p id="why">Needed for replacement scripts</p>
        <Button onClick={() => undefined} describedBy="why" variant="primary">
          Allow
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Allow' }).getAttribute('aria-describedby')).toBe('why');
  });
});

describe('RadioGroup', () => {
  const renderGroup = (onChange = vi.fn(), value: 'light' | 'standard' | 'thorough' | null = 'standard') =>
    render(
      <RadioGroup
        name="level"
        legend="Protection on this site"
        options={LEVELS}
        value={value}
        onChange={onChange}
        description="Also hides leftover ad boxes."
        note="Set on example.com."
      />,
    );

  test('is a fieldset named by its visible legend, with one native radio per option', () => {
    renderGroup();
    const group = screen.getByRole('group', { name: 'Protection on this site' });
    expect(group.tagName).toBe('FIELDSET');
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('type'))).toEqual(['radio', 'radio', 'radio']);
    expect(radios.map((r) => (r as HTMLInputElement).name)).toEqual(['level', 'level', 'level']);
    expect(screen.queryByRole('slider')).toBeNull();
  });

  test('each radio is named by its label and the checked one matches the value', () => {
    renderGroup();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Standard' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Light' }).checked).toBe(false);
  });

  test('the group, not each radio, is described by the description and the note', () => {
    renderGroup();
    expect(screen.getByRole('radio', { name: 'Thorough' }).hasAttribute('aria-describedby')).toBe(false);
    const ids = (screen.getByRole('group', { name: 'Protection on this site' }).getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['Also hides leftover ad boxes.', 'Set on example.com.']);
  });

  test('choosing an option reports its value', () => {
    const onChange = vi.fn();
    renderGroup(onChange);
    fireEvent.click(screen.getByRole('radio', { name: 'Thorough' }));
    expect(onChange).toHaveBeenCalledWith('thorough');
  });

  test('a null value checks nothing; without description the group has no aria-describedby', () => {
    render(<RadioGroup name="x" legend="Level" options={LEVELS} value={null} onChange={() => undefined} />);
    const radios = screen.getAllByRole<HTMLInputElement>('radio');
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(screen.getByRole('group', { name: 'Level' }).hasAttribute('aria-describedby')).toBe(false);
  });

  test('ids are unique per group, so two groups on one page do not collide', () => {
    render(
      <>
        <RadioGroup name="a" legend="A" options={LEVELS} value="light" onChange={() => undefined} />
        <RadioGroup name="b" legend="B" options={LEVELS} value="light" onChange={() => undefined} />
      </>,
    );
    const ids = screen.getAllByRole('radio').map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('disabled disables every radio', () => {
    render(<RadioGroup name="x" legend="Level" options={LEVELS} value="light" onChange={() => undefined} disabled />);
    expect(screen.getByRole('group', { name: 'Level' }).hasAttribute('disabled')).toBe(true);
  });

  test('has no axe violations', async () => {
    const { container } = renderGroup();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe('Banner', () => {
  test('shows its text, a decorative icon and its actions', () => {
    render(
      <Banner tone="warning" icon="reduced" text="Running as Light: site access is off" textId="t">
        <Button onClick={() => undefined}>Allow on all sites</Button>
      </Banner>,
    );
    const text = screen.getByText('Running as Light: site access is off');
    expect(text.id).toBe('t');
    expect(screen.getByRole('button', { name: 'Allow on all sites' })).toBeTruthy();
    expect(document.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test('draws no action row without actions', () => {
    const { container } = render(<Banner tone="neutral" icon="off" text="Off on this site" />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('[data-tone="neutral"]')).not.toBeNull();
  });
});

describe('Icon', () => {
  const NAMES: readonly IconName[] = ['on', 'off', 'paused', 'reduced', 'warning', 'unavailable', 'pending'];

  test('every state has its own shape, hidden from assistive technology', () => {
    const shapes = NAMES.map((name) => {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector('svg');
      const markup = svg?.innerHTML ?? '';
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('focusable')).toBe('false');
      unmount();
      return markup;
    });
    expect(new Set(shapes).size).toBe(NAMES.length);
  });
});

describe('BrandMark', () => {
  test('is decorative, drawn in token colours only, 24 px unless sized', () => {
    const { container } = render(
      <p>
        <BrandMark />
        <BrandMark size={32} class="big" />
        Glassmere
      </p>,
    );
    const [plain, big] = [...container.querySelectorAll('svg')];
    expect(plain?.getAttribute('aria-hidden')).toBe('true');
    expect(plain?.getAttribute('focusable')).toBe('false');
    expect(plain?.getAttribute('width')).toBe('24');
    expect(big?.getAttribute('width')).toBe('32');
    expect(big?.getAttribute('class')).toBe('big');
    const paints = [...container.querySelectorAll('path')].flatMap((p) => [p.getAttribute('fill'), p.getAttribute('stroke')]).filter((c) => c !== null && c !== 'none');
    expect(paints.every((c) => c === 'currentColor' || /^var\(--color-[a-z-]+\)$/.test(c ?? ''))).toBe(true);
  });
});

describe('Glyph (P3-18 icon set)', () => {
  test('every glyph has its own shape, drawn in currentColor, hidden from assistive technology', () => {
    const shapes = GLYPH_NAMES.map((name) => {
      const { container, unmount } = render(<Glyph name={name} />);
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('focusable')).toBe('false');
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
      expect(svg?.getAttribute('width')).toBe('16');
      expect(svg?.getAttribute('data-glyph')).toBe(name);
      const markup = svg?.innerHTML ?? '';
      unmount();
      return markup;
    });
    expect(new Set(shapes).size).toBe(GLYPH_NAMES.length);
  });

  test('covers the set the redesign asked for and takes a size and a class', () => {
    expect(GLYPH_NAMES).toEqual(expect.arrayContaining(['shield', 'check', 'pause', 'eyeOff', 'list', 'alert', 'settings', 'chevron', 'chevronDown', 'ad', 'tracker', 'building']));
    const { container } = render(<Glyph name="shield" size={24} class="big" />);
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('24');
    expect(container.querySelector('svg')?.getAttribute('class')).toBe('big');
  });
});
