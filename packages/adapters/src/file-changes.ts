import { runProcess } from './process.js';
import type { AgentAdapter, AgentReply, AgentTask } from './types.js';

/**
 * Snapshot of `git status`: path -> status code. Returns undefined when the folder is not a
 * git work tree, in which case changes cannot be reported.
 */
export async function gitStatusSnapshot(cwd: string): Promise<Map<string, string> | undefined> {
  try {
    const result = await runProcess({
      command: 'git',
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.exitCode !== 0) return undefined;
    return parsePorcelainZ(result.stdout);
  } catch {
    return undefined;
  }
}

/** Parses `git status --porcelain=v1 -z`. Renames carry the old path as an extra entry, skipped here. */
export function parsePorcelainZ(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  const parts = output.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    entries.set(entry.slice(3), status);
    if (status.includes('R') || status.includes('C')) i++;
  }
  return entries;
}

export function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [path, status] of after) {
    if (before.get(path) !== status) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

/**
 * Wraps an adapter so every reply reports the files that changed in the working directory,
 * whatever the provider says. Only edit-access turns can change files.
 */
export function reportingFileChanges(adapter: AgentAdapter): AgentAdapter {
  return {
    provider: adapter.provider,
    async run(task: AgentTask): Promise<AgentReply> {
      if (task.access !== 'edit') return adapter.run(task);
      const before = await gitStatusSnapshot(task.workingDirectory);
      const reply = await adapter.run(task);
      const after = await gitStatusSnapshot(task.workingDirectory);
      if (!before || !after) return reply;
      return { ...reply, changedFiles: changedBetween(before, after) };
    },
  };
}
