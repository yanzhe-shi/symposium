import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { badRequest } from '../errors.js';
import { initialProjectFile, projectFilePath, writeProjectFile } from '../project-file.js';
import { git, gitRaw, humanIdentityArgs, NO_SIGNING } from './git.js';

/**
 * Files the agent programs keep for themselves: their settings, their own instruction files.
 * Symposium gives every agent its instructions, so these have no place in a diff.
 */
export const AGENT_FILE_PATTERNS: readonly string[] = [
  '.claude/',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.gemini/',
  'GEMINI.md',
  '.antigravity/',
  'AGENTS.md',
];

/**
 * Tells git to ignore the agent programs' own files in a project, so no agent commits them.
 * The patterns go into the repo's `info/exclude`: it covers the project folder and every
 * worktree, stays on this machine and leaves the project's `.gitignore` alone. A file the
 * project already tracks is not affected. Returns whether anything had to be added.
 */
export async function ignoreAgentFiles(folder: string): Promise<boolean> {
  const gitDir = await git(folder, ['rev-parse', '--git-common-dir']);
  const file = resolve(folder, gitDir, 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  const present = new Set(current.split('\n').map((line) => line.trim()));
  const missing = AGENT_FILE_PATTERNS.filter((pattern) => !present.has(pattern));
  if (missing.length === 0) return false;
  const gap = current === '' || current.endsWith('\n') ? '' : '\n';
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${current}${gap}# Added by Symposium: files that agent programs keep for themselves\n${missing.join('\n')}\n`,
  );
  return true;
}

export interface PreparedRepository {
  baseBranch: string;
  /** What Symposium did, to tell the human. */
  actions: string[];
}

/**
 * Makes sure the project folder is the root of a git repo with at least one commit and a branch
 * checked out, so workers can branch from it. Creates project.md if missing, and has git
 * ignore the agent programs' own files. Only creates a repo or a first commit; never touches
 * an existing history.
 */
export async function prepareRepository(
  folder: string,
  groupName: string,
): Promise<PreparedRepository> {
  const actions: string[] = [];
  const toplevel = await gitRaw(folder, ['rev-parse', '--show-toplevel']);

  if (toplevel.code === 0) {
    const root = await realpath(toplevel.stdout.trim());
    if (root !== (await realpath(folder))) {
      throw badRequest(
        `${folder} is inside the git repo at ${root}. Use ${root} as the project folder.`,
      );
    }
  } else {
    await git(folder, ['init', '-q', '-b', 'main']);
    actions.push('created a git repo');
  }

  // Before the first commit, so that it does not take such files in either.
  if (await ignoreAgentFiles(folder)) actions.push('set git to ignore agent files');

  const hadProjectFile = existsSync(projectFilePath(folder));
  if (!hadProjectFile) {
    await writeProjectFile(folder, initialProjectFile(groupName));
    actions.push('added project.md');
  }

  const hasCommits = (await gitRaw(folder, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
  if (!hasCommits) {
    // A first commit gives workers something to branch from. In a new repo it includes the
    // folder's files (respecting .gitignore); in an existing empty repo it only adds project.md.
    const identity = await humanIdentityArgs(folder);
    if (actions.includes('created a git repo')) {
      await git(folder, ['add', '-A']);
    } else if (!hadProjectFile) {
      await git(folder, ['add', '--', 'project.md']);
    }
    await git(folder, [
      ...identity,
      ...NO_SIGNING,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'Start project with Symposium',
    ]);
    actions.push('made a first commit');
  }

  const branch = await gitRaw(folder, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (branch.code !== 0) {
    throw badRequest(`${folder} has no branch checked out. Check out a branch, then try again.`);
  }
  return { baseBranch: branch.stdout.trim(), actions };
}
