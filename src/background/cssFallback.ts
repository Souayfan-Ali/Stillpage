/**
 * `cs/cssFallback` (P1-38, cosmetic notes §2.2, security notes §5): a content script in a frame that cannot adopt a
 * stylesheet names its shard registration — never selector text. The worker re-derives everything:
 * the registration from the packaged catalog (ISOLATED, our id), the frame's host from `sender`
 * (Chrome fills it; for `about:blank` its origin), refuses a host the registration does not list,
 * reads the shard data from our own package, and inserts the same rules `cosmetic-specific` would
 * adopt (stock selectors only with `display:none!important`, `:style()` re-sanitised) as USER-origin
 * CSS into that one frame. The answer carries a count only.
 */
import { cssRulesFor } from '../content/cosmetic-specific/apply.js';
import type { CatalogRegistration } from '../core/catalog/registrations.js';
import type { Catalog } from '../core/catalog/types.js';
import { PROCEDURAL_ENGINE, RUNTIME_SCRIPTS } from '../core/content/files.js';
import { frameHost } from '../core/content/frame.js';
import { isShardData } from '../core/content/guard.js';
import { shardFileWrap } from '../core/content/shard-data.js';
import { isSameOrSubdomain } from '../core/hostname/walk.js';
import type { Hostname } from '../core/ids.js';
import type { MessageError, Response, SenderInfo } from '../core/messaging/parse.js';
import type { Ports } from '../platform/ports.js';

const failure = (code: MessageError['code'], message: string): Response<never> => ({ ok: false, error: { code, message } });
const RUNTIME = new Set<string>([...Object.values(RUNTIME_SCRIPTS), PROCEDURAL_ENGINE]);

/** The plain and the full code set of one shard (D-41, P2-47; were `''`, `:p`, `:j`, `:pj`). */
const VARIANTS = ['', ':f'];

/** The base registration `iso:<pack>:<shard>` and its full variant, matched exactly (security review LOW 3). */
function registrationsOf(catalog: Catalog, base: string): readonly CatalogRegistration[] {
  if (!/^iso:[a-z][a-z0-9-]*:\d+$/.test(base)) return [];
  const ids = new Set(VARIANTS.map((v) => `${base}${v}`));
  return Object.values(catalog.packs).flatMap((p) => p.registrations).filter((r) => r.world === 'ISOLATED' && ids.has(r.id));
}

function senderHost(sender: SenderInfo): Hostname | null {
  const url = sender.url ?? '';
  const http = /^https?:/.test(url);
  return frameHost({ hostname: http ? new URL(url).hostname : '', origin: sender.origin ?? 'null' });
}

/** The data file of a registration: its one entry that is not code (scriptlets, engine, runtime scripts). */
const dataPath = (r: CatalogRegistration): string | undefined => r.js.find((p) => !p.startsWith('scriptlets/') && !RUNTIME.has(p));

function parseShard(text: string): unknown {
  const { prefix, suffix } = shardFileWrap('ISOLATED');
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  try {
    return JSON.parse(text.slice(prefix.length, -suffix.length)) as unknown;
  } catch {
    return null;
  }
}

export async function cssFallback(base: string, sender: SenderInfo, ports: Ports): Promise<Response<{ rules: number }>> {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const host = senderHost(sender);
  if (tabId === undefined || frameId === undefined || host === null) return failure('forbidden-sender', 'no frame to insert into');
  try {
    const regs = registrationsOf(await ports.catalog.read(), base);
    if (regs.length === 0) return failure('not-found', 'no such registration');
    if (!regs.some((r) => r.hosts.some((h) => isSameOrSubdomain(host, h)))) return failure('forbidden-sender', 'frame host not in the registration');
    const path = regs.map(dataPath).find((p) => p !== undefined);
    const data: unknown = path === undefined ? null : parseShard(await ports.package.readText(path));
    if (!isShardData(data)) return failure('internal', 'shard data unreadable');
    const rules = cssRulesFor([data], host);
    if (rules.length > 0) await ports.scripting.insertCSS({ target: { tabId, frameIds: [frameId] }, css: rules.join('\n'), origin: 'USER' });
    return { ok: true, data: { rules: rules.length } };
  } catch (error) {
    ports.log.error('cs/cssFallback failed', error);
    return failure('internal', 'css fallback failed');
  }
}
