/**
 * "No non-loopback request" (testing notes §3, S-05): the TCP peers of the browser processes started for a
 * test profile, from `ss`. Only processes whose command line names that profile are counted, so other
 * browsers on the machine never pollute the check.
 */
import { execFileSync } from 'node:child_process';

const LOOPBACK_PEER = /^(127\.|\[::1\]|\[::ffff:127\.)/;

function run(command: string, args: readonly string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** Peers outside 127.0.0.0/8 and ::1 of every TCP socket held by a process started for `profileDir`. */
export function nonLoopbackPeers(profileDir: string): readonly string[] {
  const pids = run('pgrep', ['-f', profileDir])
    .split('\n')
    .filter((pid) => pid !== '');
  if (pids.length === 0) return [];
  const sockets = run('ss', ['-tnpH']).split('\n');
  return sockets
    .filter((line) => pids.some((pid) => line.includes(`pid=${pid},`)))
    .map((line) => line.trim().split(/\s+/)[4] ?? '')
    .filter((peer) => peer !== '' && !LOOPBACK_PEER.test(peer));
}

/** Number of processes started for `profileDir` (the socket check is vacuous when it is 0). */
export function processCount(profileDir: string): number {
  return run('pgrep', ['-f', profileDir])
    .split('\n')
    .filter((pid) => pid !== '').length;
}
