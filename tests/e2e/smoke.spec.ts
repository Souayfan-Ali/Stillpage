import { STORE_NAME } from '../../src/core/brand.js';
import { MIN_CHROME_VERSION } from '../../src/core/limits.js';
import { DECLARED_PERMISSIONS } from '../../src/core/manifest.js';
import { expect, test } from './fixtures.js';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

test('the built extension loads and its service worker starts', ({
  serviceWorker,
  extensionId,
}) => {
  // Assert
  expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
  expect(extensionId).toMatch(EXTENSION_ID_PATTERN);
});

test('the running worker reports the manifest we built', async ({ serviceWorker }) => {
  // Act
  const manifest = await serviceWorker.evaluate(() => {
    const { name, manifest_version, minimum_chrome_version, permissions } =
      chrome.runtime.getManifest();
    return { name, manifest_version, minimum_chrome_version, permissions };
  });

  // Assert
  expect(manifest).toEqual({
    name: STORE_NAME,
    manifest_version: 3,
    minimum_chrome_version: MIN_CHROME_VERSION,
    permissions: [...DECLARED_PERMISSIONS],
  });
});
