/**
 * Id-resolution bot CLI (P2-16), run by `.github/workflows/issue-idmap.yml` with `GH_TOKEN` =
 * `github.token`. Reads the event from `GITHUB_EVENT_PATH`; every `gh` call is an argv (`execFile`),
 * never a shell string, and the issue body is never put on a command line. Id maps are release assets
 * `idmap-<rulesetId>.json` on tag `rules/<version>` (the version is validated before use).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { handle, readEvent, type BotComment, type Gh } from './bot.js';

const run = promisify(execFile);
/** `gh release download` reports a missing release or asset this way; anything else fails the job. */
const MISSING = /release not found|no assets match|not found \(HTTP 404\)/i;
const BOT_LOGIN = 'github-actions[bot]';
const MAX_BUFFER = 32 * 1024 * 1024;

function repoOf(env: NodeJS.ProcessEnv): string {
  const repo = env['GITHUB_REPOSITORY'] ?? '';
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new Error('GITHUB_REPOSITORY is not owner/repo');
  return repo;
}

const gh = (args: readonly string[]): Promise<{ stdout: string }> => run('gh', [...args], { maxBuffer: MAX_BUFFER });

/** One `{id, body, login}` line of the comments listing, checked before use. */
function commentOf(line: string): BotComment {
  const c = JSON.parse(line) as { id?: unknown; body?: unknown; login?: unknown };
  if (typeof c.id !== 'number' || !Number.isSafeInteger(c.id)) throw new Error('unexpected comment listing');
  return { id: c.id, body: typeof c.body === 'string' ? c.body : '', ours: c.login === BOT_LOGIN };
}

function createGh(repo: string, dir: string): Gh {
  return {
    idMap: async (version, rulesetId) => {
      const name = `idmap-${rulesetId}.json`;
      try {
        await gh(['release', 'download', `rules/${version}`, `--repo=${repo}`, `--pattern=${name}`, `--dir=${dir}`, '--clobber']);
      } catch (error) {
        // Only a missing release or asset is "no id map"; auth, rate limit or network fail the job (review MEDIUM).
        const stderr = (error as { stderr?: unknown }).stderr;
        if (typeof stderr === 'string' && MISSING.test(stderr)) return null;
        throw error;
      }
      return JSON.parse(await readFile(path.join(dir, name), 'utf8')) as unknown;
    },
    comments: async (issue) => {
      const { stdout } = await gh(['api', '--paginate', `repos/${repo}/issues/${String(issue)}/comments`, '--jq', '.[] | {id, body, login: .user.login}']);
      return stdout
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map(commentOf);
    },
    createComment: async (issue, body) => {
      const file = path.join(dir, 'comment.json');
      await writeFile(file, JSON.stringify({ body }));
      await gh(['api', '-X', 'POST', `repos/${repo}/issues/${String(issue)}/comments`, `--input=${file}`]);
    },
    updateComment: async (id, body) => {
      const file = path.join(dir, 'comment.json');
      await writeFile(file, JSON.stringify({ body }));
      await gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${String(id)}`, `--input=${file}`]);
    },
    addLabels: async (issue, labels) => {
      const file = path.join(dir, 'labels.json');
      await writeFile(file, JSON.stringify({ labels }));
      await gh(['api', '-X', 'POST', `repos/${repo}/issues/${String(issue)}/labels`, `--input=${file}`]);
    },
  };
}

async function main(): Promise<void> {
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (eventPath === undefined) throw new Error('GITHUB_EVENT_PATH is not set');
  const event = readEvent(JSON.parse(await readFile(eventPath, 'utf8')));
  if (event === null) {
    process.stdout.write('not an issue event this bot handles; nothing to do\n');
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'idmap-'));
  try {
    const { labels } = await handle(event, createGh(repoOf(process.env), dir));
    process.stdout.write(`issue #${String(event.issue)}: comment written${labels.length > 0 ? `, labels ${labels.join(', ')}` : ''}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`idmap bot failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
