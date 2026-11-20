/**
 * Unit-test setup (P2-40): the pages read their copy through `chrome.i18n`, so every test file gets
 * Chrome's lookup over the shipped English catalog before its imports run.
 */
import { createI18n, englishCatalog } from '../../helpers/chromeI18n.js';

const scope = globalThis as { chrome?: object };
scope.chrome = { ...scope.chrome, i18n: createI18n(englishCatalog()) };
