// Picker panel entry (P2-19): wires `startPanel` to `storage.session`, the tab and the worker.
import '../../ui/tokens.css';
import './panel.css';
import { startPanel } from '../../features/picker-panel/panel.js';
import { renderPanel, renderToast, showPanelError } from '../../features/picker-panel/view.js';
import { intersectionWatch } from '../../features/picker-panel/visibility.js';
import { panelPort } from '../../platform/picker.js';
import { applyDocumentLocale, t } from '../../ui/i18n.js';

applyDocumentLocale(document);
document.title = t('picker_title');
const wait = document.querySelector('.wait');
if (wait !== null) wait.textContent = t('common_loading');

const watch = intersectionWatch(window, () => performance.now());

startPanel({
  ...panelPort(),
  window,
  now: () => Date.now(),
  render: (model, actions) => renderPanel(document, model, actions, watch),
  showError: (text) => { showPanelError(document, text); },
  showToast: (actions) => {
    renderToast(document, actions, (run, ms) => {
      const id = setTimeout(run, ms);
      return () => { clearTimeout(id); };
    }, watch);
  },
});
