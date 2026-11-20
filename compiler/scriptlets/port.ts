/**
 * The scriptlet side of the content build (P1-29), from the vendored uBO files: library, name
 * resolution, facts and code files. Build time only.
 */
import type { ScriptletPort } from '../content/build.js';
import type { VendorLock } from '../vendor/lock.js';
import { vendorReader } from '../vendor/node-ports.js';
import { readRedirectResources } from '../vendor/resources.js';
import type { UboParser } from '../vendor/ubo.js';
import { bundle } from './bundle.js';
import { expandAllExceptions, scriptletFacts } from './facts.js';
import { readLibrary, resolver, type Library, type WarScript } from './library.js';

const RESOURCES_DIR = 'src/js/resources/';
const EXTRA = ['src/js/urlskip.js', 'src/js/jsonpath.js', 'src/js/arglist-parser.js'];
const WAR_DIR = 'src/web_accessible_resources/';

/** Reads the library from the vendored files (hash-checked). */
export async function loadLibrary(lock: VendorLock, dir?: string): Promise<Library> {
  const read = vendorReader(lock, dir);
  const paths = [...Object.keys(lock.files).filter((f) => f.startsWith(RESOURCES_DIR) && f.endsWith('.js')), ...EXTRA];
  const files = new Map(await Promise.all(paths.map(async (p) => [p, (await read(p)).toString('utf8')] as const)));
  const resources = readRedirectResources((await read('src/js/redirect-resources.js')).toString('utf8'));
  const war: WarScript[] = await Promise.all(resources.filter((r) => r.name.endsWith('.js') && Object.hasOwn(lock.files, `${WAR_DIR}${r.name}`))
    .map(async (r) => ({ file: r.name, aliases: r.aliases, text: (await read(`${WAR_DIR}${r.name}`)).toString('utf8') })));
  return readLibrary(files, war);
}

/** The port the content build uses. `commit` is named in each code file's notice. */
export function scriptletPort(lib: Library, ubo: UboParser, commit: string): ScriptletPort {
  const resolve = resolver(lib);
  return {
    facts: (entry, ctx) => scriptletFacts(entry, ubo, resolve, ctx),
    code: (pack, world, names) => bundle(lib, pack, world, names.map((n) => {
      const d = resolve(n);
      if (d === undefined) throw new Error(`scriptlet "${n}" vanished from the library`);
      return d;
    }), commit),
    expand: expandAllExceptions,
  };
}
