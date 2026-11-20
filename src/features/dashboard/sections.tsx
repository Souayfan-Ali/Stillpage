/** The dashboard's sections by id (P2-34…P2-38, P2-22). */
import type { ComponentChildren } from 'preact';
import type { Dashboard } from '../../core/messaging/dashboard.js';
import { AboutSection } from './about/AboutSection.js';
import type { RestoreStore } from './backup/backupStore.js';
import { BackupSection } from './backup/BackupSection.js';
import { HiddenSection } from './hidden/HiddenSection.js';
import { PrivacySection } from './privacy/PrivacySection.js';
import { ProtectionSection } from './sections/ProtectionSection.js';
import { SitesSection } from './sites/SitesSection.js';
import type { DashboardStore } from './store.js';
import type { SectionId } from './strings.js';

/** What the sections need besides the snapshot; made once per page. */
export interface SectionDeps {
  readonly store: DashboardStore;
  readonly restore: RestoreStore;
  readonly version: string;
  readonly now: () => number;
}

export function renderSection(deps: SectionDeps, section: SectionId, data: Dashboard): ComponentChildren {
  const { store } = deps;
  switch (section) {
    case 'protection':
      return <ProtectionSection store={store} data={data} />;
    case 'sites':
      return <SitesSection store={store} data={data} now={deps.now} />;
    case 'hidden':
      return <HiddenSection store={store} data={data} />;
    case 'privacy':
      return <PrivacySection store={store} data={data} />;
    case 'backup':
      return <BackupSection data={data} restore={deps.restore} now={deps.now} say={(text) => {
            store.say(text);
          }}
        />;
    case 'about':
      return <AboutSection version={deps.version} />;
  }
}
