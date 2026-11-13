import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { commandExists } from '@symposium/adapters';
import type { AppContext } from './context.js';
import { conflict } from './errors.js';
import { branchName, worktreePath } from './git/workspaces.js';
import type { Group } from './protocol.js';
import { listAgents } from './store/agents.js';

/** One folder of a VS Code multi-root workspace. */
export interface WorkspaceFolder {
  name: string;
  path: string;
}

/**
 * Where the group's VS Code workspace file lives. Worktrees stay in Symposium's data folder,
 * out of the project, so the project's own tools do not scan the copies. The workspace file
 * puts the project and every worktree side by side in one VS Code window instead.
 */
export function workspaceFilePath(dataDir: string, group: Group): string {
  const slug =
    group.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'group';
  // Two groups may share a name, so the id tells their files apart.
  return join(dataDir, 'workspaces', `${slug}-${group.id.slice(0, 8)}.code-workspace`);
}

/** The project folder first, then the worktree of every agent on the team that has one. */
export function workspaceFolders(ctx: AppContext, group: Group): WorkspaceFolder[] {
  if (!group.folderPath) return [];
  const folders = [{ name: `${group.name} (project)`, path: group.folderPath }];
  for (const agent of listAgents(ctx.db, group.id)) {
    const path = worktreePath(ctx.dataDir, group, agent);
    if (existsSync(join(path, '.git'))) {
      folders.push({ name: `${agent.name} (${branchName(agent)})`, path });
    }
  }
  return folders;
}

/**
 * Writes the group's `.code-workspace` file and returns its path. Called when the team or its
 * worktrees change, so a VS Code window that has the file open follows along. The file is
 * left alone when nothing changed.
 */
export async function writeWorkspaceFile(ctx: AppContext, group: Group): Promise<string> {
  const file = workspaceFilePath(ctx.dataDir, group);
  const content = `${JSON.stringify({ folders: workspaceFolders(ctx, group), settings: {} }, null, 2)}\n`;
  const current = await readFile(file, 'utf8').catch(() => undefined);
  if (current !== content) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return file;
}

/** `writeWorkspaceFile` for callers that cannot wait and must not fail because of it. */
export function refreshWorkspaceFile(ctx: AppContext, group: Group): void {
  void writeWorkspaceFile(ctx, group).catch(() => undefined);
}

/**
 * Starts VS Code on a workspace file, a folder or a file. Only ever called because the human
 * clicked a button. Uses the `code` command from PATH and says so clearly when it is missing.
 */
export async function openInVsCode(ctx: AppContext, args: string[]): Promise<void> {
  if (!(await commandExists(ctx.vscodeCommand))) {
    throw conflict(
      `The \`${ctx.vscodeCommand}\` command was not found on your PATH. In VS Code, run "Shell Command: Install 'code' command in PATH" from the Command Palette, then try again.`,
    );
  }
  const child = spawn(ctx.vscodeCommand, args, { stdio: 'ignore', detached: true });
  // VS Code outlives the request, and the engine.
  child.on('error', () => undefined);
  child.unref();
}
