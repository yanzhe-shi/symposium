import { spawn } from 'node:child_process';
import { bwrapArgs, type Sandbox } from '@symposium/adapters';
import type { CheckResult, CheckStatus } from './protocol.js';

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/** How much of the end of a check's output is kept, in characters. */
export const MAX_CHECK_OUTPUT = 8000;
export const MAX_CHECK_COMMAND_LENGTH = 1000;
const KILL_GRACE_MS = 2000;

/**
 * Runs the project's check command, such as `npm test`, in one folder and says how it went.
 * The human chose the command in the group's settings. It runs after a worker's turn, on that
 * worker's changes, so it executes code an agent wrote.
 *
 * With a `sandbox` it is confined as the worker was.
 *
 * Never throws: a command that cannot start, runs too long or is stopped is a result too.
 */
export async function runCheck(
  command: string,
  cwd: string,
  options: { timeoutMs?: number; signal?: AbortSignal; sandbox?: Sandbox } = {},
): Promise<CheckResult> {
  const started = Date.now();
  const { timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, signal } = options;
  const [program, args] = options.sandbox
    ? ['bwrap', [...(await bwrapArgs(options.sandbox, cwd)), 'sh', '-c', command]]
    : ['sh', ['-c', command]];

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ command, status: 'stopped', exitCode: null, output: '', durationMs: 0 });
      return;
    }
    let output = '';
    let cut = false;
    let ending: CheckStatus | undefined;
    let settled = false;
    const finish = (status: CheckStatus, exitCode: number | null, note = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onStop);
      const text = `${cut ? '… earlier output left out\n' : ''}${output}${note}`;
      resolve({ command, status, exitCode, output: text, durationMs: Date.now() - started });
    };

    // Its own process group, so stopping it also reaches whatever the command started.
    const child = spawn(program, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const kill = (name: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, name);
      } catch {
        // Already gone.
      }
    };
    const end = (status: CheckStatus): void => {
      if (ending) return;
      ending = status;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    const onStop = (): void => end('stopped');
    const timer = setTimeout(() => end('timed-out'), timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onStop, { once: true });

    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > MAX_CHECK_OUTPUT) {
        output = output.slice(-MAX_CHECK_OUTPUT);
        cut = true;
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => finish('error', null, `Could not start: ${error.message}\n`));
    child.on('close', (code) => {
      if (ending) finish(ending, null);
      else finish(code === 0 ? 'passed' : 'failed', code);
    });
  });
}

/** A check result in a few words: "passed", "failed (exit code 1)", "took too long". */
export function describeCheck(check: Pick<CheckResult, 'status' | 'exitCode'>): string {
  switch (check.status) {
    case 'running':
      return 'running';
    case 'passed':
      return 'passed';
    case 'failed':
      return check.exitCode === null ? 'failed' : `failed (exit code ${check.exitCode})`;
    case 'timed-out':
      return 'took too long and was stopped';
    case 'stopped':
      return 'stopped before it finished';
    case 'error':
      return 'could not start';
  }
}
