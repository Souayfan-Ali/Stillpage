/** Shared checks for the documents and the store listing (P2-49, P2-50). */

/** Opening mark of every document with legal weight (Q-09, Q-03). */
export const DRAFT_MARK = 'DRAFT, not legally reviewed';

/** Phrases performance notes §8 and store notes §3 forbid until a gate backs them. */
export const UNBACKED_CLAIMS = /\b(faster|fastest|lighter|less memory|uses less|lower memory|blocks all|100 ?%|every ad)\b/i;

/** Width and height of a PNG, read from its IHDR chunk; `null` when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
