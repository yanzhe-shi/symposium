import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import type { ProviderId } from './types.js';

/**
 * What a provider's process may touch during one turn, enforced by the kernel and not by the
 * provider. The engine decides it; an adapter only passes it on to `runProcess`.
 *
 * The process sees the whole disk read-only, except:
 * - `writable`: files and folders it may change, such as the agent's worktree.
 * - `hidden`: files and folders it sees empty, such as `~/.ssh`. What it writes there is
 *   thrown away with the turn.
 * - `readOnly`: files and folders it may read but not change, where they lie inside one of the
 *   above.
 *
 * Where two of them nest, the deeper path wins. Paths that do not exist are left out.
 */
export interface Sandbox {
  writable: string[];
  readOnly: string[];
  hidden: string[];
}

/**
 * The files a provider's CLI keeps under the user's home, as paths relative to it. The CLI
 * must be able to write its login and caches. Its settings stay read-only, so that an agent
 * cannot plant something there for the user's own next session, and its records of the user's
 * other sessions are hidden.
 */
export const PROVIDER_STATE: Record<ProviderId, Sandbox> = {
  'claude-code': {
    writable: ['.claude', '.claude.json'],
    readOnly: [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/CLAUDE.md',
      '.claude/agents',
      '.claude/commands',
      '.claude/hooks',
      '.claude/plugins',
      '.claude/skills',
    ],
    hidden: [
      '.claude/file-history',
      '.claude/history.jsonl',
      '.claude/plans',
      '.claude/projects',
      '.claude/sessions',
      '.claude/shell-snapshots',
    ],
  },
  antigravity: { writable: ['.gemini'], readOnly: [], hidden: [] },
  'openai-compatible': { writable: [], readOnly: [], hidden: [] },
  mock: { writable: [], readOnly: [], hidden: [] },
};

type MountKind = keyof Sandbox;

interface Mount {
  kind: MountKind;
  path: string;
  isFile: boolean;
}

/** The path with links followed, and whether it is a file. Undefined when nothing is there. */
async function existing(kind: MountKind, path: string): Promise<Mount | undefined> {
  try {
    const real = await realpath(path);
    return { kind, path: real, isFile: !(await stat(real)).isDirectory() };
  } catch {
    return undefined;
  }
}

function depth(path: string): number {
  return path.split(sep).filter(Boolean).length;
}

function mountArgs({ kind, path, isFile }: Mount): string[] {
  if (kind === 'writable') return ['--bind', path, path];
  if (kind === 'readOnly') return ['--ro-bind', path, path];
  // An empty folder in memory, or the null device in place of a file.
  return isFile ? ['--dev-bind', '/dev/null', path] : ['--tmpfs', path];
}

/**
 * The `bwrap` (bubblewrap) arguments that confine a command to `sandbox`. The command itself
 * and its own arguments follow them.
 */
export async function bwrapArgs(sandbox: Sandbox, cwd: string): Promise<string[]> {
  const found = await Promise.all(
    (['writable', 'readOnly', 'hidden'] as const).flatMap((kind) =>
      sandbox[kind].map((path) => existing(kind, path)),
    ),
  );
  // A folder is mounted before what lies inside it, so the deeper path has the last word.
  const mounts = found
    .filter((mount) => mount !== undefined)
    .sort((a, b) => depth(a.path) - depth(b.path));
  return [...BASE_ARGS, ...mounts.flatMap(mountArgs), '--chdir', cwd, '--'];
}

const BASE_ARGS = [
  // The whole disk, read-only, with fresh /dev and /proc.
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  // Its own process list: it cannot see or signal anything outside.
  '--unshare-pid',
  // No way to type into the terminal Symposium was started from.
  '--new-session',
  '--die-with-parent',
];

let probe: Promise<boolean> | undefined;

/**
 * Whether this computer can sandbox: Linux with a `bwrap` that is allowed to work. Some
 * systems and most containers forbid it. Asked once.
 */
export function sandboxAvailable(): Promise<boolean> {
  probe ??= new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve(false);
    execFile('bwrap', [...BASE_ARGS, '--', 'true'], { timeout: 10_000 }, (error) =>
      resolve(error === null),
    );
  });
  return probe;
}
