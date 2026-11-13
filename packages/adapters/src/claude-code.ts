import {
  asRecord,
  deniedEvent,
  displayPath,
  firstString,
  parseJsonLine,
  textEvent,
  toolEvent,
} from './events.js';
import { runProcess } from './process.js';
import {
  AdapterError,
  DEFAULT_TIMEOUT_MS,
  type AgentAccess,
  type AgentAdapter,
  type AgentEvent,
  type AgentReply,
  type AgentTask,
} from './types.js';

// Bash is never offered: running commands needs human approval.
const TOOLS_BY_ACCESS: Record<AgentAccess, string> = {
  edit: 'Read,Grep,Glob,Edit,Write',
  read: 'Read,Grep,Glob',
  none: '',
};

type ToolKind = 'read' | 'edit' | 'search' | 'command' | 'tool';

const KIND_BY_TOOL: Record<string, ToolKind> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  Bash: 'command',
};

const PATH_INPUTS = ['file_path', 'notebook_path', 'path'];
const TARGET_INPUTS: Record<ToolKind, readonly string[]> = {
  read: PATH_INPUTS,
  edit: PATH_INPUTS,
  search: ['pattern', 'query'],
  command: ['command'],
  tool: [...PATH_INPUTS, 'pattern', 'query', 'url'],
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
    // One JSON object per line as the turn goes on, ending with the result. Needs --verbose.
    '--output-format',
    'stream-json',
    '--verbose',
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
  if (task.effort && task.effort !== 'default') args.push('--effort', task.effort);
  return args;
}

function contentBlocks(line: Record<string, unknown>): Record<string, unknown>[] {
  const content = asRecord(line.message)?.content;
  if (!Array.isArray(content)) return [];
  return content.map(asRecord).filter((block) => block !== undefined);
}

/**
 * Turns the lines of Claude Code's `stream-json` output into progress events. Returns the
 * function to feed each line to.
 *
 * - An edit is reported when its result arrives without an error, so "edited x" is true.
 * - Other tools are reported when they are called.
 * - Text is reported once something follows it. The last text is the reply itself, which the
 *   result line carries, so it is not reported twice.
 */
export function claudeEventReader(
  cwd: string,
  onEvent: (event: AgentEvent) => void,
): (line: string) => void {
  const pendingEdits = new Map<string, AgentEvent>();
  let pendingText: AgentEvent | undefined;

  function flushText(): void {
    if (pendingText) onEvent(pendingText);
    pendingText = undefined;
  }

  function onToolUse(block: Record<string, unknown>): void {
    const tool = typeof block.name === 'string' ? block.name : 'a tool';
    const kind = KIND_BY_TOOL[tool] ?? 'tool';
    const raw = firstString(asRecord(block.input), TARGET_INPUTS[kind]);
    const isPath = kind === 'read' || kind === 'edit' || kind === 'tool';
    const target = raw !== undefined && isPath ? displayPath(raw, cwd) : raw;
    const event = toolEvent(kind, tool, target);
    if (kind === 'edit' && typeof block.id === 'string') pendingEdits.set(block.id, event);
    else onEvent(event);
  }

  return (text) => {
    const line = parseJsonLine(text);
    if (!line) return;

    if (line.type === 'assistant') {
      flushText();
      for (const block of contentBlocks(line)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          flushText();
          pendingText = textEvent(block.text);
        } else if (block.type === 'tool_use') {
          flushText();
          onToolUse(block);
        }
      }
    } else if (line.type === 'user') {
      flushText();
      for (const block of contentBlocks(line)) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const edit = pendingEdits.get(block.tool_use_id);
        pendingEdits.delete(block.tool_use_id);
        if (edit && block.is_error !== true) onEvent(edit);
      }
    } else if (line.type === 'system' && line.subtype === 'permission_denied') {
      const tool = typeof line.tool_name === 'string' ? line.tool_name : 'a tool';
      const reason = firstString(line, ['decision_reason', 'message']) ?? 'not allowed';
      onEvent(deniedEvent(tool, reason));
    }
  };
}

/**
 * Finds the result in Claude Code's output: the last `result` line of a `stream-json` stream,
 * or a single JSON object as `--output-format json` prints.
 */
export function parseClaudeOutput(stdout: string): { text: string; costUsd?: number } {
  const lines = stdout
    .split('\n')
    .map(parseJsonLine)
    .filter((line) => line !== undefined);
  let parsed = lines.findLast((line) => line.type === 'result') as ClaudeResult | undefined;
  if (!parsed) {
    try {
      parsed = JSON.parse(stdout.trim()) as ClaudeResult;
    } catch {
      throw new AdapterError(
        lines.length > 0
          ? 'Claude Code stopped before giving a result'
          : 'Claude Code returned output that is not JSON',
        stdout.slice(-2000),
      );
    }
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
      onStdoutLine: task.onEvent && claudeEventReader(task.workingDirectory, task.onEvent),
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
