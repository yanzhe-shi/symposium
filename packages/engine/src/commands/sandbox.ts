import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { PROVIDER_STATE, type ProviderId, type Sandbox } from '@symposium/adapters';
import type { AppContext } from '../context.js';
import type { Group } from '../protocol.js';

export const MAX_SANDBOX_FOLDERS = 20;
export const MAX_SANDBOX_FOLDER_LENGTH = 500;

/**
 * Places under the home folder that hold keys, logins and private data. An agent's process
 * sees them empty. Nothing an agent does for a project needs them.
 */
const SECRETS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  '.netrc',
  '.git-credentials',
  '.pypirc',
  '.config/gh',
  '.config/gcloud',
  '.config/op',
  '.config/git/credentials',
  '.local/share/keyrings',
  // Browsers and mail: saved passwords and sessions.
  '.mozilla',
  '.thunderbird',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  '.config/microsoft-edge',
  '.var/app',
];

/**
 * Where package managers keep what they download. A worker that installs or builds must be
 * able to write here, or `npm install` and its like fail.
 */
const PACKAGE_CACHES = [
  '.npm',
  '.cache/pnpm',
  '.local/share/pnpm',
  '.cache/yarn',
  '.yarn/berry/cache',
  '.bun/install/cache',
  '.cache/pip',
  '.cache/uv',
  '.cargo/registry',
  '.cargo/git',
  '.cache/go-build',
  'go/pkg/mod',
  '.m2/repository',
  '.gradle/caches',
];

export interface SandboxInput {
  home: string;
  /** Symposium's own data: the database, every agent's memory and worktree. */
  dataDir: string;
  uid: number;
  projectFolder: string;
  /** Where the process works: an agent's worktree, or the project folder. */
  cwd: string;
  /** Whether it may change files in `cwd`. */
  canEdit: boolean;
  /** The provider whose CLI runs, if one does: it must reach its own login. */
  provider?: ProviderId;
  /** Folders the human added in the group's settings. */
  extraFolders: string[];
}

/**
 * The rule for what one process may touch. This is the gate behind "agents edit only in their
 * own worktree": the kernel refuses everything else, whatever the model or the provider does.
 *
 * - It may change its own folder if its file access says so, the package caches, the folders
 *   the human added, and its provider's login.
 * - It may read the project and the rest of the disk.
 * - It sees empty: the places for secrets, the logins of other providers, Symposium's data
 *   (other agents' folders and memory, the chat), the temporary folders, and the user's
 *   session sockets (the keyring, the ssh agent).
 */
export function decideSandbox(input: SandboxInput): Sandbox {
  const { home, cwd, projectFolder } = input;
  const inHome = (paths: string[]): string[] => paths.map((path) => join(home, path));
  const state = input.provider ? PROVIDER_STATE[input.provider] : undefined;
  // A provider's login is for its own CLI: not for another provider's agent, nor for a check.
  const otherLogins = Object.entries(PROVIDER_STATE)
    .filter(([id]) => id !== input.provider)
    .flatMap(([, other]) => other.writable);
  const writable = [
    ...(input.canEdit ? [cwd] : []),
    ...inHome(PACKAGE_CACHES),
    ...input.extraFolders,
    ...inHome(state?.writable ?? []),
  ];
  return {
    writable,
    // Named because they may lie inside a hidden folder: a worktree's git data is in the
    // project, and a reviewer reads a worker's worktree.
    readOnly: [
      ...[projectFolder, cwd].filter((path) => !writable.includes(path)),
      ...inHome(state?.readOnly ?? []),
    ],
    hidden: [
      ...inHome(SECRETS),
      ...inHome(state?.hidden ?? []),
      ...inHome(otherLogins),
      input.dataDir,
      tmpdir(),
      '/tmp',
      '/var/tmp',
      `/run/user/${input.uid}`,
      '/run/docker.sock',
      '/run/podman',
    ],
    sessionBus: state?.sessionBus,
  };
}

/**
 * The sandbox for a process that works for this group, or nothing: when the human switched
 * the sandbox off for the group, or when this computer cannot sandbox.
 */
export async function sandboxFor(
  ctx: AppContext,
  group: Group,
  work: Pick<SandboxInput, 'cwd' | 'canEdit' | 'provider'>,
): Promise<Sandbox | undefined> {
  if (!group.sandbox || !group.folderPath) return undefined;
  if (!(await ctx.canSandbox(work.provider))) return undefined;
  return decideSandbox({
    ...work,
    home: homedir(),
    dataDir: ctx.dataDir,
    uid: userInfo().uid,
    projectFolder: group.folderPath,
    extraFolders: group.sandboxFolders,
  });
}

/**
 * Checks the folders the human wants writable. Returns them tidied, or a message for the
 * human. The whole disk or the whole home folder would undo the sandbox.
 */
export function validateSandboxFolders(
  folders: string[],
  home = homedir(),
): { folders: string[] } | { error: string } {
  const tidy = new Set<string>();
  for (const typed of folders.map((folder) => folder.trim()).filter(Boolean)) {
    if (!isAbsolute(typed)) return { error: `Give the full path of the folder: ${typed}` };
    // Without `..` and without a slash at the end.
    const folder = resolve(typed);
    if (folder === '/' || folder === resolve(home)) {
      return { error: `${typed} is too much to open up. Name the folder that is needed.` };
    }
    tidy.add(folder);
  }
  return { folders: [...tidy] };
}
