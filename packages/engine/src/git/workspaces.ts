import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { conflict } from '../errors.js';
import type { Agent, Group } from '../protocol.js';
import { agentIdentityArgs, git, gitRaw, humanIdentityArgs, NO_SIGNING } from './git.js';

export const MAX_DIFF_CHARS = 200_000;

export interface Worktree {
  path: string;
  branch: string;
}

export interface PendingDiff {
  commit: string;
  files: string[];
  stat: string;
  diff: string;
  truncated: boolean;
}

/** Each worker's branch. One per agent per group; a rehired agent gets its old branch back. */
export function branchName(agent: Agent): string {
  return `symposium/${agent.name.toLowerCase()}`;
}

/** Worktrees live in Symposium's data folder, so the project folder stays clean. */
export function worktreePath(dataDir: string, group: Group, agent: Agent): string {
  return join(dataDir, 'worktrees', group.id, agent.id);
}

function requireRepo(group: Group): { folder: string; base: string } {
  if (!group.folderPath || !group.baseBranch) {
    throw conflict('This group has no git project folder');
  }
  return { folder: group.folderPath, base: group.baseBranch };
}

async function branchExists(folder: string, branch: string): Promise<boolean> {
  return (await gitRaw(folder, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])).code === 0;
}

/** Opens the worker's worktree on its own branch, creating both if needed. */
async function openWorktree(dataDir: string, group: Group, agent: Agent): Promise<Worktree> {
  const { folder, base } = requireRepo(group);
  const branch = branchName(agent);
  const path = worktreePath(dataDir, group, agent);
  if (!existsSync(join(path, '.git'))) {
    await git(folder, ['worktree', 'prune']);
    await mkdir(dirname(path), { recursive: true });
    if (await branchExists(folder, branch)) {
      await git(folder, ['worktree', 'add', '-q', path, branch]);
    } else {
      await git(folder, ['worktree', 'add', '-q', '-b', branch, path, base]);
    }
  }
  return { path, branch };
}

/**
 * Gets the worker's worktree ready for a turn: creates it if needed and brings it up to date
 * with the base branch when that is safe. Returns a warning when it could not be updated.
 */
export async function ensureWorktree(
  dataDir: string,
  group: Group,
  agent: Agent,
): Promise<Worktree & { warning?: string }> {
  const worktree = await openWorktree(dataDir, group, agent);
  const warning = await updateFromBase(worktree.path, agent, requireRepo(group).base);
  return { ...worktree, warning };
}

/**
 * Brings merged work up to date so the next task starts from the latest base branch.
 * Fast-forwards when the branch has nothing unmerged; otherwise merges the base in, and backs
 * out on conflict.
 */
async function updateFromBase(
  path: string,
  agent: Agent,
  base: string,
): Promise<string | undefined> {
  const behind = (await gitRaw(path, ['merge-base', '--is-ancestor', base, 'HEAD'])).code !== 0;
  if (!behind) return undefined;
  const status = await git(path, ['status', '--porcelain']);
  if (status !== '')
    return `${agent.name}'s worktree has uncommitted changes, so it was not updated from ${base}.`;

  const fastForward =
    (await gitRaw(path, ['merge-base', '--is-ancestor', 'HEAD', base])).code === 0;
  if (fastForward) {
    await git(path, ['merge', '-q', '--ff-only', base]);
    return undefined;
  }
  const merged = await gitRaw(path, [
    ...agentIdentityArgs(agent.name),
    'merge',
    '-q',
    '--no-edit',
    base,
  ]);
  if (merged.code === 0) return undefined;
  await gitRaw(path, ['merge', '--abort']);
  return `${agent.name}'s branch conflicts with ${base}. Merge or discard their pending changes, then try again.`;
}

/** Commits everything the agent changed. Returns the commit, or undefined if nothing changed. */
export async function commitWork(
  worktree: Worktree,
  agent: Agent,
  summary: string,
): Promise<string | undefined> {
  await git(worktree.path, ['add', '-A']);
  const staged = await gitRaw(worktree.path, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return undefined;
  const title =
    summary
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? 'Update';
  const subject = `${agent.name}: ${title.length > 60 ? `${title.slice(0, 57)}...` : title}`;
  await git(worktree.path, [...agentIdentityArgs(agent.name), 'commit', '-q', '-m', subject]);
  return git(worktree.path, ['rev-parse', 'HEAD']);
}

/** Everything on the agent's branch that is not yet in the base branch. */
export async function pendingDiff(group: Group, agent: Agent): Promise<PendingDiff | undefined> {
  const { folder, base } = requireRepo(group);
  const branch = branchName(agent);
  if (!(await branchExists(folder, branch))) return undefined;
  const range = `${base}...${branch}`;
  const files = (await git(folder, ['diff', '--name-only', range])).split('\n').filter(Boolean);
  if (files.length === 0) return undefined;
  const fullDiff = await git(folder, ['diff', range]);
  const truncated = fullDiff.length > MAX_DIFF_CHARS;
  return {
    commit: await git(folder, ['rev-parse', branch]),
    files,
    stat: await git(folder, ['diff', '--stat', range]),
    diff: truncated ? fullDiff.slice(0, MAX_DIFF_CHARS) : fullDiff,
    truncated,
  };
}

/**
 * Merges the agent's branch into the base branch in the project folder. Only ever called when the
 * human approves. Backs out cleanly on conflict.
 */
export async function mergeWork(group: Group, agent: Agent): Promise<string> {
  const { folder, base } = requireRepo(group);
  const branch = branchName(agent);
  const current = (await gitRaw(folder, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (current !== base) {
    throw conflict(
      `Your project folder has ${current || 'a detached HEAD'} checked out. Check out ${base} to merge.`,
    );
  }
  const result = await gitRaw(folder, [
    ...(await humanIdentityArgs(folder)),
    ...NO_SIGNING,
    'merge',
    '--no-ff',
    '-m',
    `Merge ${branch} (approved in Symposium)`,
    branch,
  ]);
  if (result.code !== 0) {
    const inMerge =
      (await gitRaw(folder, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;
    if (inMerge) {
      const conflicted = await git(folder, ['diff', '--name-only', '--diff-filter=U']);
      await gitRaw(folder, ['merge', '--abort']);
      throw conflict(
        `Merging ${agent.name}'s work conflicts with ${base} in: ${conflicted.split('\n').join(', ')}. Nothing was changed. Ask ${agent.name} to rework it, or discard it.`,
      );
    }
    throw conflict(`git could not merge: ${(result.stderr || result.stdout).trim()}`);
  }
  return git(folder, ['rev-parse', 'HEAD']);
}

/** Throws away the agent's unmerged work by resetting its branch to the base. Human-approved only. */
export async function discardWork(dataDir: string, group: Group, agent: Agent): Promise<void> {
  const { base } = requireRepo(group);
  const worktree = await openWorktree(dataDir, group, agent);
  await git(worktree.path, ['reset', '-q', '--hard', base]);
  await git(worktree.path, ['clean', '-q', '-fd']);
}
