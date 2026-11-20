// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, test } from 'vitest';
import { AboutSection } from '../../../../src/features/dashboard/about/AboutSection.js';
import { LIST_AUTHORS, SHIPPED_CODE } from '../../../../src/features/dashboard/about/credits.js';
import { LISTS } from '../../../../src/features/dashboard/packLists.js';
import { axeViolations } from '../../ui/axe.js';

afterEach(cleanup);

const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../../package.json'), 'utf8')) as { dependencies: Record<string, string> };

describe('About and Credits (P2-38)', () => {
  test('every list has authors; shipped code names every runtime dependency', () => {
    expect(Object.keys(LIST_AUTHORS).sort()).toEqual(Object.keys(LISTS).sort());
    expect(SHIPPED_CODE.map((c) => c.name).filter((n) => n !== 'uBlock Origin').sort()).toEqual(Object.keys(pkg.dependencies).sort());
  });

  test('version, rules date, licence and credits with safe external links; no axe violations', () => {
    const { container } = render(<AboutSection version="0.0.1" />);
    expect(screen.getByText('0.0.1')).toBeTruthy();
    // D-99: no date, no "Rules from" row; the lists sit behind "Filter lists (N)"; shipped code stays open.
    expect(screen.queryByText('Rules from')).toBeNull();
    const lists = container.querySelector('details');
    expect(lists?.querySelector('summary')?.textContent).toBe(`Filter lists (${String(Object.keys(LISTS).length)})`);
    expect(lists?.querySelectorAll('li')).toHaveLength(Object.keys(LISTS).length);
    expect(screen.getByRole('heading', { level: 3, name: 'Code from others in this package' }).closest('details')).toBeNull();
    expect(screen.getByText(/GNU General Public License version 3/)).toBeTruthy();
    const links = [...container.querySelectorAll('a')];
    expect(links.length).toBe(Object.keys(LISTS).length + SHIPPED_CODE.length);
    expect(links.every((a) => a.rel === 'noopener noreferrer' && a.target === '_blank' && a.href.startsWith('https://'))).toBe(true);
    return axeViolations(container).then((v) => {
      expect(v).toEqual([]);
    });
  });

  test('a release version shows its rules date', () => {
    render(<AboutSection version="1.0.316.1430" />);
    expect(screen.getByText('Rules from')).toBeTruthy();
  });
});
