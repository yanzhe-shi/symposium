import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitError';
  }
}

const MAX_BUFFER = 50 * 1024 * 1024;

/** Runs git in `cwd`. Never prompts. Resolves with the exit code instead of throwing. */
export function gitRaw(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

/** Runs git and returns trimmed stdout, or throws a GitError. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitRaw(cwd, args);
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout.trim();
}

/** Symposium's own commits are never signed, because signing can prompt for a passphrase. */
export const NO_SIGNING = ['-c', 'commit.gpgsign=false'];

/** `-c` flags that set the commit author, without signing. */
export function identityArgs(name: string, email: string): string[] {
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`, ...NO_SIGNING];
}

/** Commits by agents carry the agent's name, so the log shows who made each change. */
export function agentIdentityArgs(agentName: string): string[] {
  return identityArgs(`${agentName} (Symposium agent)`, 'agents@symposium.local');
}

/**
 * The user's own identity for commits they approve, falling back to a Symposium identity when
 * git has none configured.
 */
export async function humanIdentityArgs(cwd: string): Promise<string[]> {
  const name = (await gitRaw(cwd, ['config', 'user.name'])).stdout.trim();
  const email = (await gitRaw(cwd, ['config', 'user.email'])).stdout.trim();
  if (name && email) return [];
  return identityArgs(name || 'Symposium', email || 'symposium@symposium.local');
}
