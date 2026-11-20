/**
 * The guard's bootstrap names (P2-58, cosmetic notes §6a): the ISOLATED sentinel announces a per-document
 * secret on `BOOT_EVENT` and answers one `HELLO_EVENT` from the MAIN shim (two-way handshake, S-20).
 * Both run before any page script; the secret then names the cancelable request event.
 */
export const BOOT_EVENT = 'x-gb';
export const HELLO_EVENT = 'x-gh';
