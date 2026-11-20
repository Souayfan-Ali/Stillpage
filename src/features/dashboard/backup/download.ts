/** Saves text as a file from the page (P2-37): a Blob URL and a `download` link, nothing leaves the device. */
export function saveTextFile(name: string, text: string, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

/** `glassmere-backup-2026-11-14.json` for `now` (UTC date). */
export function backupFileName(prefix: string, now: number): string {
  return `${prefix}-${new Date(now).toISOString().slice(0, 10)}.json`;
}
