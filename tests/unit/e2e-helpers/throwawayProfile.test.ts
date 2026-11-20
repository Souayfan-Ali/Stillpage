import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { assertThrowawayProfile, createThrowawayProfile, removeThrowawayProfiles, THROWAWAY_MARKER } from '../../e2e/helpers/throwawayProfile.js';

afterAll(async () => { await removeThrowawayProfiles(); });

describe('the packed-install harness only touches profiles this test run created (D-33 safety)', () => {
  test('a profile it created is accepted', async () => {
    const dir = await createThrowawayProfile();
    expect(path.dirname(dir)).toBe(await realpath(tmpdir()));
    await expect(assertThrowawayProfile(dir)).resolves.toBeUndefined();
  });

  test.each([
    path.join(homedir(), '.config', 'chromium'),
    path.join(homedir(), '.config', 'google-chrome'),
    homedir(),
    '/',
  ])('a real or system path is refused: %s', async (dir) => {
    await expect(assertThrowawayProfile(dir)).rejects.toThrow(/not a throwaway profile/);
  });

  test('a temp dir it did not create is refused, even with a forged marker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'glassmere-packed-profile-'));
    try {
      await writeFile(path.join(dir, THROWAWAY_MARKER), 'forged');
      await expect(assertThrowawayProfile(dir)).rejects.toThrow(/not a throwaway profile/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a created profile whose marker was changed, or a symlink to it, is refused', async () => {
    const dir = await createThrowawayProfile();
    const link = `${dir}-link`;
    await symlink(dir, link);
    try {
      await expect(assertThrowawayProfile(link)).rejects.toThrow(/not a throwaway profile/);
      await writeFile(path.join(dir, THROWAWAY_MARKER), 'changed');
      await expect(assertThrowawayProfile(dir)).rejects.toThrow(/marker/);
    } finally {
      await rm(link, { force: true });
    }
  });
});
