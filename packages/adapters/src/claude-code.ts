import { runProcess } from './process.js';
import {
  AdapterError,
  DEFAULT_TIMEOUT_MS,
  type AgentAccess,
  type AgentAdapter,
  type AgentReply,
  type AgentTask,
} from './types.js';

// Bash is never offered: running commands needs human approval.
const TOOLS_BY_ACCESS: Record<AgentAccess, string> = {
  edit: 'Read,Grep,Glob,Edit,Write',
  read: 'Read,Grep,Glob',
  none: '',
};

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
}

/** Builds the `claude` arguments. The prompt goes in on stdin. */
export function claudeCodeArgs(task: AgentTask): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    // Restricted mode removes command-running tools, ignores the user's settings files and
    // confines file tools to the working directory.
    '--restricted',
    '--strict-mcp-config',
    '--permission-prompts',
    'none',
    '--tools',
    TOOLS_BY_ACCESS[task.access],
    '--append-system-prompt',
    task.systemPrompt,
  ];
  if (task.access === 'edit') args.push('--permission-mode', 'acceptEdits');
  if (task.model) args.push('--model', task.model);
  return args;
}

export function parseClaudeOutput(stdout: string): { text: string; costUsd?: number } {
  let parsed: ClaudeResult;
  try {
    parsed = JSON.parse(stdout.trim()) as ClaudeResult;
  } catch {
    throw new AdapterError('Claude Code returned output that is not JSON', stdout.slice(0, 2000));
  }
  if (parsed.is_error || typeof parsed.result !== 'string') {
    throw new AdapterError(
      `Claude Code reported an error (${parsed.subtype ?? 'unknown'})`,
      parsed.result,
    );
  }
  return { text: parsed.result, costUsd: parsed.total_cost_usd };
}

/** Runs the official `claude` CLI in print mode with the user's own login. */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = 'claude-code' as const;

  constructor(private readonly command = 'claude') {}

  async run(task: AgentTask): Promise<AgentReply> {
    const result = await runProcess({
      command: this.command,
      args: claudeCodeArgs(task),
      cwd: task.workingDirectory,
      input: task.prompt,
      signal: task.signal,
      timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 && result.stdout.trim() === '') {
      throw new AdapterError(
        `claude exited with code ${result.exitCode}`,
        result.stderr.slice(0, 2000),
      );
    }
    const { text, costUsd } = parseClaudeOutput(result.stdout);
    return { text, costUsd, changedFiles: [] };
  }
}
