import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { badRequest } from '../errors.js';
import { initialProjectFile, projectFilePath, writeProjectFile } from '../project-file.js';
import { git, gitRaw, humanIdentityArgs, NO_SIGNING } from './git.js';

export interface PreparedRepository {
  baseBranch: string;
  /** What Symposium did, to tell the human. */
  actions: string[];
}

/**
 * Makes sure the project folder is the root of a git repo with at least one commit and a branch
 * checked out, so workers can branch from it. Creates project.md if missing.
 * Only creates a repo or a first commit; never touches an existing history.
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
