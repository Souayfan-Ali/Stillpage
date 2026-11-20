// First-run page entry (P2-33): opened by the worker on install; mounts the steps and wires the page port.
import '../../ui/tokens.css';
import '../../ui/switch.css';
import { render } from 'preact';
import { createRequest } from '../../features/dashboard/client.js';
import { OnboardingApp } from '../../features/onboarding/OnboardingApp.js';
import { createOnboardingStore } from '../../features/onboarding/store.js';
import { applyTheme } from '../../features/popup/page.js';
import { createSettingsPagePort } from '../../platform/settingsPage.js';
import { applyDocumentLocale } from '../../ui/i18n.js';

const root = document.getElementById('app');
if (root !== null) {
  applyDocumentLocale(document);
  const page = createSettingsPagePort();
  const language = page.uiLanguage();
  const store = createOnboardingStore({ request: createRequest(page), requestOrigins: (origins) => page.requestOrigins(origins), language });
  root.replaceChildren();
  render(<OnboardingApp store={store} language={language} privacyUrl="/dashboard.html#privacy" dashboardUrl="/dashboard.html" />, root);
  store.data.subscribe((data) => {
    if (data !== null && data !== 'unavailable') applyTheme(document.documentElement, data.settings.ui.theme);
  });
  void store.load();
}
