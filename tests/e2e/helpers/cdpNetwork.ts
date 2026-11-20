/**
 * Network log over raw CDP for J16 (P1-46, security notes §9): a second, local-only DevTools connection
 * (the browser's `DevToolsActivePort`) auto-attaches, flattened, to every target — pages, frames,
 * extension pages and the extension's worker — with `waitForDebuggerOnStart`, so a target is logged
 * from its first instruction, and records every `Network.requestWillBeSent` with the target it came
 * from. Playwright cannot open a CDP session on a worker, hence the raw socket (Node's `WebSocket`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

interface CallFrame {
  readonly url: string;
}

interface Initiator {
  readonly type: string;
  readonly url?: string;
  readonly stack?: { readonly callFrames: readonly CallFrame[]; readonly parent?: Initiator['stack'] };
}

export interface LoggedRequest {
  readonly targetType: string;
  readonly targetUrl: string;
  readonly url: string;
  /** The document (or worker script) that made the request; a target's own URL is stale after navigation. */
  readonly documentUrl: string;
  /** Every script URL named by the initiator (its URL and its stack, parents included). */
  readonly initiatorUrls: readonly string[];
}

export interface NetworkLog {
  readonly requests: () => readonly LoggedRequest[];
  readonly close: () => Promise<void>;
}

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

function initiatorUrls(initiator: Initiator | undefined): string[] {
  const urls: string[] = initiator?.url === undefined ? [] : [initiator.url];
  for (let stack = initiator?.stack; stack !== undefined; stack = stack.parent) urls.push(...stack.callFrames.map((f) => f.url));
  return urls.filter((u) => u !== '');
}

async function browserSocket(profileDir: string): Promise<WebSocket> {
  const [port = '', wsPath = ''] = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('CDP socket failed'));
    });
  });
  return socket;
}

/** Starts logging; needs the browser launched with `RELOAD_ARGS` (remote debugging on loopback). */
export async function startNetworkLog(profileDir: string): Promise<NetworkLog> {
  const socket = await browserSocket(profileDir);
  const sessions = new Map<string, TargetInfo>();
  let requests: readonly LoggedRequest[] = [];
  let nextId = 0;
  const send = (method: string, params: object = {}, sessionId?: string): void => {
    nextId += 1;
    socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  };
  const attached = (params: Record<string, unknown>): void => {
    const sessionId = params['sessionId'] as string;
    sessions.set(sessionId, params['targetInfo'] as TargetInfo);
    // In order on one session: logging is on before the target runs its first instruction.
    send('Network.enable', {}, sessionId);
    send('Target.setAutoAttach', AUTO_ATTACH, sessionId);
    send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  };
  const logged = (params: Record<string, unknown>, sessionId: string | undefined): void => {
    const target = sessionId === undefined ? undefined : sessions.get(sessionId);
    const request = params['request'] as { url: string };
    const documentUrl = typeof params['documentURL'] === 'string' ? params['documentURL'] : '';
    const entry = { targetType: target?.type ?? 'unknown', targetUrl: target?.url ?? '', url: request.url, documentUrl, initiatorUrls: initiatorUrls(params['initiator'] as Initiator | undefined) };
    requests = [...requests, entry];
  };
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as Message;
    if (message.method === 'Target.attachedToTarget' && message.params !== undefined) attached(message.params);
    if (message.method === 'Network.requestWillBeSent' && message.params !== undefined) logged(message.params, message.sessionId);
  });
  send('Target.setAutoAttach', AUTO_ATTACH);
  return {
    requests: () => requests,
    close: () =>
      new Promise((resolve) => {
        socket.addEventListener('close', () => {
          resolve();
        });
        socket.close();
      }),
  };
}

const LOCAL_SCHEMES = ['data:', 'blob:'];

/**
 * Requests the extension made: anything its worker or its pages fetched outside its own package, and
 * any request a web page made with one of the extension's scripts in the initiator.
 */
export function extensionInitiated(requests: readonly LoggedRequest[], extensionId: string): readonly LoggedRequest[] {
  const own = `chrome-extension://${extensionId}/`;
  const outside = (url: string): boolean => !url.startsWith(own) && !LOCAL_SCHEMES.some((s) => url.startsWith(s));
  return requests.filter((r) => {
    if ((r.documentUrl || r.targetUrl).startsWith(own)) return outside(r.url);
    return outside(r.url) && r.initiatorUrls.some((u) => u.startsWith('chrome-extension://'));
  });
}
