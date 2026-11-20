/** Hash routes of the dashboard (design review, P2-34): `#sites` etc.; an unknown or empty hash is Protection. */
import { SECTIONS, type SectionId } from './strings.js';

export function sectionOf(hash: string): SectionId {
  const id = hash.startsWith('#') ? hash.slice(1) : hash;
  return SECTIONS.find((section) => section === id) ?? 'protection';
}
