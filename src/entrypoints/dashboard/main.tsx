// Dashboard entry (P2-34): mounts the shell, follows the hash route and wires the page port.
import '../../ui/tokens.css';
import '../../ui/switch.css';
import { render } from 'preact';
import { createRequest } from '../../features/dashboard/client.js';
import { DashboardApp } from '../../features/dashboard/DashboardApp.js';
import { sectionOf } from '../../features/dashboard/route.js';
import { createRestoreStore } from '../../features/dashboard/backup/backupStore.js';
import { renderSection } from '../../features/dashboard/sections.js';
import { createDashboardStore } from '../../features/dashboard/store.js';
import { applyTheme } from '../../features/popup/page.js';
import { createSettingsPagePort } from '../../platform/settingsPage.js';
import { applyDocumentLocale } from '../../ui/i18n.js';

const root = document.getElementById('app');
if (root !== null) {
  applyDocumentLocale(document);
  const page = createSettingsPagePort();
  const request = createRequest(page);
  const store = createDashboardStore({ request, requestOrigins: (origins) => page.requestOrigins(origins) });
  const deps = { store, restore: createRestoreStore(
      request,
      () => store.load(),
      () => (store.snapshot.value.kind === 'ready' ? store.snapshot.value.data.packs : []),
    ), version: page.version(), now: () => Date.now() };
  const draw = (navigated: boolean): void => {
    render(
      <DashboardApp store={store} section={sectionOf(location.hash)} navigated={navigated} renderSection={(section, data) => renderSection(deps, section, data)} />,
      root,
    );
  };
  root.replaceChildren();
  draw(false);
  // Settings change elsewhere too (toolbar panel, another tab): read them again on navigation and
  // whenever the tab comes back into view, so a backup is never saved from a stale copy.
  addEventListener('hashchange', () => {
    draw(true);
    void store.load();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void store.load();
  });
  store.snapshot.subscribe((snapshot) => {
    if (snapshot.kind === 'ready') applyTheme(document.documentElement, snapshot.data.settings.ui.theme);
  });
  void store.load();
}
