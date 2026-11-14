import {
  asRecord,
  deniedCommandEvent,
  deniedEvent,
  displayPath,
  firstString,
  outputEvent,
  parseJsonLine,
  textEvent,
  toolEvent,
  type ToolKind,
} from './events.js';
import { pausingForApproval, runProcess, TurnClock, type ProcessStdin } from './process.js';
import {
  AdapterError,
  DEFAULT_TIMEOUT_MS,
  type AgentAccess,
  type AgentAdapter,
  type AgentEvent,
  type AgentReply,
  type AgentTask,
  type CommandDecision,
} from './types.js';

const TOOLS_BY_ACCESS: Record<AgentAccess, string[]> = {
  edit: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
  read: ['Read', 'Grep', 'Glob'],
  none: [],
};

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

/**
 * Whether this turn may run terminal commands. Each one is put to the engine first, so there
 * must be someone to ask.
 */
export function offersCommands(task: AgentTask): boolean {
  return task.onCommand !== undefined && task.commands !== undefined && task.commands !== 'off';
}

/** Builds the `claude` arguments. The prompt goes in on stdin. */
export function claudeCodeArgs(task: AgentTask): string[] {
  const commands = offersCommands(task);
  const tools = [...TOOLS_BY_ACCESS[task.access], ...(commands ? ['Bash'] : [])];
  const args = [
    '-p',
    // One JSON object per line as the turn goes on, ending with the result. Needs --verbose.
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    // Restricted mode ignores the user's settings files, confines file tools to the working
    // directory, and offers command-running tools only when --tools names them.
    '--restricted',
    '--strict-mcp-config',
    ...(commands
      ? // The CLI is talked to while it runs: it asks on stdout before a command and reads the
        // answer from stdin. See ClaudeHost.
        [
          '--input-format',
          'stream-json',
          '--permission-prompts',
          'host',
          '--permission-prompt-tool',
          'stdio',
        ]
      : // Nobody answers prompts: anything that would ask is refused.
        ['--permission-prompts', 'none']),
    '--tools',
    tools.join(','),
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

/** The text of a tool result, which is a string or a list of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => asRecord(block)?.text)
    .filter((text) => typeof text === 'string')
    .join('\n');
}

/**
 * Turns the lines of Claude Code's `stream-json` output into progress events. Returns the
 * function to feed each line to.
 *
 * - An edit is reported when its result arrives without an error, so "edited x" is true.
 * - Other tools are reported when they are called.
 * - Text is reported once something follows it. The last text is the reply itself, which the
 *   result line carries, so it is not reported twice.
 * - With `allowedCommands` (tool call id → command, filled in as commands are allowed), a Bash
 *   call is not reported here: whoever decides on it reports the decision. Its result is.
 */
export function claudeEventReader(
  cwd: string,
  onEvent: (event: AgentEvent) => void,
  allowedCommands?: ReadonlyMap<string, string>,
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
    if (kind === 'command' && allowedCommands) return;
    const raw = firstString(asRecord(block.input), TARGET_INPUTS[kind]);
    const isPath = kind === 'read' || kind === 'edit' || kind === 'tool';
    const target = raw !== undefined && isPath ? displayPath(raw, cwd) : raw;
    const event = toolEvent(kind, tool, target);
    if (kind === 'edit' && typeof block.id === 'string') pendingEdits.set(block.id, event);
    else onEvent(event);
  }

  function onToolResult(block: Record<string, unknown>): void {
    const id = block.tool_use_id;
    if (typeof id !== 'string') return;
    const edit = pendingEdits.get(id);
    pendingEdits.delete(id);
    if (edit && block.is_error !== true) onEvent(edit);

    const command = allowedCommands?.get(id);
    if (command === undefined) return;
    const output = resultText(block.content);
    // A failing command's result starts with its exit code.
    const exit = /^Exit code (\d+)\n?/.exec(output);
    onEvent(
      outputEvent('Bash', command, {
        output: exit ? output.slice(exit[0].length) : output,
        exitCode: exit ? Number(exit[1]) : undefined,
        failed: block.is_error === true,
      }),
    );
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
        if (block.type === 'tool_result') onToolResult(block);
      }
    } else if (line.type === 'system' && line.subtype === 'permission_denied') {
      const tool = typeof line.tool_name === 'string' ? line.tool_name : 'a tool';
      const reason = firstString(line, ['decision_reason', 'message']) ?? 'not allowed';
      onEvent(deniedEvent(tool, reason));
    }
  };
}

const COMMAND_HOOK = 'symposium-command';
// How long the CLI waits for an answer about one command, in seconds. The engine gives up on a
// human well before this.
const HOOK_TIMEOUT_SECONDS = 900;

/**
 * Talks to a running `claude` that was started to ask before commands (see `claudeCodeArgs`).
 * Messages are JSON lines in both directions:
 *
 * - On start this sends `initialize`, registering a hook that the CLI calls before every Bash
 *   command, including ones it would have run without asking. Then it sends the prompt.
 * - The CLI sends a `hook_callback` request for each command. The answer, from
 *   `task.onCommand`, allows or refuses it.
 * - The CLI may still send `can_use_tool`, for a command or for a file tool reaching outside
 *   the working directory. A command that was already allowed stays allowed, a new one is put
 *   to `task.onCommand`, and anything else is refused.
 * - After the `result` line stdin is closed, which lets the CLI exit.
 */
export class ClaudeHost {
  /** Tool call id → command, for the commands that were allowed to run. */
  readonly allowedCommands = new Map<string, string>();
  private readonly decisions = new Map<string, Promise<CommandDecision>>();

  constructor(
    private readonly task: AgentTask,
    private readonly stdin: ProcessStdin,
  ) {}

  start(): void {
    this.send({
      type: 'control_request',
      request_id: 'symposium-init',
      request: {
        subtype: 'initialize',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hookCallbackIds: [COMMAND_HOOK], timeout: HOOK_TIMEOUT_SECONDS },
          ],
        },
      },
    });
    this.send({ type: 'user', message: { role: 'user', content: this.task.prompt } });
  }

  onLine(text: string): void {
    const line = parseJsonLine(text);
    if (!line) return;
    if (line.type === 'result') {
      this.stdin.end();
      return;
    }
    const request = line.type === 'control_request' ? asRecord(line.request) : undefined;
    const requestId = line.request_id;
    if (!request || typeof requestId !== 'string') return;
    void this.answer(requestId, request);
  }

  private async answer(requestId: string, request: Record<string, unknown>): Promise<void> {
    if (request.subtype === 'hook_callback' && request.callback_id === COMMAND_HOOK) {
      const input = asRecord(request.input);
      const decision = await this.decide(
        asRecord(input?.tool_input),
        firstString(request, ['tool_use_id']) ?? firstString(input, ['tool_use_id']),
      );
      this.respond(requestId, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.allow ? 'allow' : 'deny',
          permissionDecisionReason: decision.reason ?? (decision.allow ? 'Allowed.' : 'Refused.'),
        },
      });
    } else if (request.subtype === 'can_use_tool') {
      const input = asRecord(request.input);
      const decision =
        request.tool_name === 'Bash'
          ? await this.decide(input, firstString(request, ['tool_use_id']))
          : { allow: false, reason: 'Symposium does not allow this. Stay inside your folder.' };
      this.respond(
        requestId,
        decision.allow
          ? { behavior: 'allow', updatedInput: input ?? {} }
          : { behavior: 'deny', message: decision.reason ?? 'Refused.' },
      );
    } else {
      this.send({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: 'Not supported by Symposium' },
      });
    }
  }

  /** Puts one command to the engine. The CLI may ask twice about one call: it gets one answer. */
  private decide(
    input: Record<string, unknown> | undefined,
    toolUseId: string | undefined,
  ): Promise<CommandDecision> {
    const known = toolUseId === undefined ? undefined : this.decisions.get(toolUseId);
    if (known) return known;
    const command = firstString(input, ['command']) ?? '';
    const decision = this.ask(command, firstString(input, ['description'])).then((answer) => {
      if (answer.allow) {
        if (toolUseId !== undefined) this.allowedCommands.set(toolUseId, command);
        this.task.onEvent?.(toolEvent('command', 'Bash', command));
      } else {
        this.task.onEvent?.(deniedCommandEvent('Bash', command, answer.reason ?? 'refused'));
      }
      return answer;
    });
    if (toolUseId !== undefined) this.decisions.set(toolUseId, decision);
    return decision;
  }

  private async ask(command: string, description: string | undefined): Promise<CommandDecision> {
    if (command.trim() === '') return { allow: false, reason: 'The command was empty.' };
    try {
      return await this.task.onCommand!({ command, description });
    } catch {
      return { allow: false, reason: 'Symposium could not decide on this command.' };
    }
  }

  private respond(requestId: string, response: Record<string, unknown>): void {
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  private send(message: Record<string, unknown>): void {
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }
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

  async run(original: AgentTask): Promise<AgentReply> {
    // Time spent waiting for the human to allow a command does not count toward the turn.
    const clock = new TurnClock(original.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const task = pausingForApproval(original, clock);
    const options = {
      command: this.command,
      args: claudeCodeArgs(task),
      cwd: task.workingDirectory,
      signal: task.signal,
      clock,
    };
    let result;
    if (offersCommands(task)) {
      let host: ClaudeHost | undefined;
      let readEvents: ((line: string) => void) | undefined;
      result = await runProcess({
        ...options,
        onStart: (stdin) => {
          host = new ClaudeHost(task, stdin);
          readEvents =
            task.onEvent &&
            claudeEventReader(task.workingDirectory, task.onEvent, host.allowedCommands);
          host.start();
        },
        onStdoutLine: (line) => {
          readEvents?.(line);
          host?.onLine(line);
        },
      });
    } else {
      result = await runProcess({
        ...options,
        input: task.prompt,
        onStdoutLine: task.onEvent && claudeEventReader(task.workingDirectory, task.onEvent),
      });
    }
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
