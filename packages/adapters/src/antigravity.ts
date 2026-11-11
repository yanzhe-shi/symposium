import { runProcess, runUnderPty, type ProcessOptions, type ProcessResult } from './process.js';
import {
  AdapterError,
  DEFAULT_TIMEOUT_MS,
  type AgentAccess,
  type AgentAdapter,
  type AgentReply,
  type AgentTask,
} from './types.js';

// The sandbox restricts terminal use; plan mode makes no edits.
const MODE_ARGS: Record<AgentAccess, string[]> = {
  edit: ['--mode', 'accept-edits', '--sandbox'],
  read: ['--mode', 'plan', '--sandbox'],
  none: ['--mode', 'plan', '--sandbox'],
};

interface AgyResult {
  status?: string;
  response?: string;
}

/** `agy` has no system prompt flag, so the system prompt goes at the top of the prompt. */
export function antigravityArgs(task: AgentTask): string[] {
  const prompt = `${task.systemPrompt}\n\n---\n\n${task.prompt}`;
  const args = ['-p', prompt, '--output-format', 'json', ...MODE_ARGS[task.access]];
  if (task.model) args.push('--model', task.model);
  return args;
}

export interface AntigravityOutput {
  text: string;
  warning?: string;
}

export function parseAntigravityOutput(stdout: string): AntigravityOutput {
  const trimmed = stdout.trim();
  // Under a terminal the CLI may print other text first, so read from the first '{'.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let parsed: AgyResult | undefined;
    try {
      parsed = JSON.parse(trimmed.slice(start)) as AgyResult;
    } catch {
      // Not JSON after all; use the raw text below.
    }
    if (parsed) {
      const text = typeof parsed.response === 'string' ? parsed.response.trim() : '';
      if (!parsed.status || parsed.status === 'SUCCESS') return { text };
      // agy sometimes reports ERROR after finishing the work. Keep a real reply, flag the status.
      if (text !== '') return { text, warning: `Antigravity reported status ${parsed.status}` };
      throw new AdapterError(`Antigravity reported status ${parsed.status}`);
    }
  }
  return { text: trimmed };
}

/**
 * Runs the official `agy` CLI in print mode with the user's own login.
 * `agy -p` may print nothing when stdout is not a TTY; then it is run again under a pseudo-terminal.
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly provider = 'antigravity' as const;

  constructor(private readonly command = 'agy') {}

  async run(task: AgentTask): Promise<AgentReply> {
    const options: ProcessOptions = {
      command: this.command,
      args: antigravityArgs(task),
      cwd: task.workingDirectory,
      signal: task.signal,
      timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    let result: ProcessResult = await runProcess(options);
    if (result.exitCode === 0 && result.stdout.trim() === '') {
      result = await runUnderPty(options);
    }
    if (result.exitCode !== 0) {
      throw new AdapterError(
        `agy exited with code ${result.exitCode}`,
        (result.stderr || result.stdout).slice(0, 2000),
      );
    }
    const { text, warning } = parseAntigravityOutput(result.stdout);
    if (text === '') throw new AdapterError('agy returned an empty reply');
    return { text, warning, changedFiles: [] };
  }
}
