import { antigravityModel, antigravityPrompt, KIND_BY_TOOL } from './antigravity.js';
import {
  asRecord,
  deniedCommandEvent,
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
  CancelledError,
  DEFAULT_TIMEOUT_MS,
  type AgentReply,
  type AgentTask,
} from './types.js';

// The Agent Client Protocol's own names for what a tool call does.
const KIND_BY_ACP_KIND: Record<string, ToolKind> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  execute: 'command',
};

const EXIT_GRACE_MS = 5000;

type Json = Record<string, unknown>;

/** A JSON-RPC error sent back to the agent, or received from it. */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * JSON-RPC 2.0 over lines of stdin and stdout, in both directions: this side calls the agent,
 * and the agent sends requests (it wants permission) and notifications (what it is doing).
 */
export class AcpConnection {
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (result: Json) => void; reject: (error: Error) => void }
  >();
  private closed: Error | undefined;

  constructor(
    private readonly stdin: ProcessStdin,
    private readonly handlers: {
      onRequest: (method: string, params: Json) => Promise<Json>;
      onNotification: (method: string, params: Json) => void;
    },
  ) {}

  call(method: string, params: Json): Promise<Json> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  onLine(text: string): void {
    const message = parseJsonLine(text);
    if (!message) return;
    const params = asRecord(message.params) ?? {};
    if (typeof message.method !== 'string') {
      const waiter = typeof message.id === 'number' ? this.waiting.get(message.id) : undefined;
      if (!waiter) return;
      this.waiting.delete(message.id as number);
      const error = asRecord(message.error);
      if (error) waiter.reject(new RpcError(Number(error.code), String(error.message)));
      else waiter.resolve(asRecord(message.result) ?? {});
    } else if (message.id === undefined || message.id === null) {
      this.handlers.onNotification(message.method, params);
    } else {
      const id = message.id;
      this.handlers.onRequest(message.method, params).then(
        (result) => this.send({ jsonrpc: '2.0', id, result }),
        (error: unknown) =>
          this.send({
            jsonrpc: '2.0',
            id,
            error: {
              code: error instanceof RpcError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
    }
  }

  /** Fails every call still waiting, and every later one. Used when the process has gone. */
  close(error: Error): void {
    this.closed = error;
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }

  private send(message: Json): void {
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * One turn with `agy acp`. Handles what the agent sends while the turn goes on:
 *
 * - `session/request_permission`: a command is put to `task.onCommand`. Anything else is
 *   refused, because in the modes used here `agy` only asks about a file when it lies outside
 *   the working folder, or when the agent may not edit.
 * - `session/update`: tool calls become progress events, and message text is collected.
 */
export class AcpTurn {
  /** Tool call ids of commands already reported as running. */
  private readonly running = new Set<string>();
  private readonly refused = new Set<string>();
  /** The commands that were refused, for `stoppedNote`. */
  private readonly refusedCommands: string[] = [];
  private readonly reported = new Set<string>();
  /** What the agent has said since its last tool call. At the end, this is the reply. */
  private said = '';
  private lastSaid = '';

  constructor(private readonly task: AgentTask) {}

  get reply(): string {
    return this.said.trim() || this.lastSaid.trim();
  }

  /**
   * `agy` ends its turn without a word when a command is refused. This says so in its place,
   * so the chat does not show a silent turn. Undefined when nothing was refused.
   */
  get stoppedNote(): string | undefined {
    if (this.refusedCommands.length === 0) return undefined;
    const commands = this.refusedCommands.map((command) => `\`${command}\``).join(', ');
    return `(Stopped without a reply: ${commands} was not allowed to run, and Antigravity ends its turn when a command is refused.)`;
  }

  async onRequest(method: string, params: Json): Promise<Json> {
    if (method !== 'session/request_permission') throw new RpcError(-32601, 'Method not found');
    const call = asRecord(params.toolCall) ?? {};
    const options = Array.isArray(params.options) ? params.options.map(asRecord) : [];
    const allow = this.kindOf(call) === 'command' ? await this.decideCommand(call) : false;
    const wanted = allow ? 'allow_once' : 'reject_once';
    const optionId = options.find((option) => option?.kind === wanted)?.optionId;
    // Without a matching answer to give, backing out refuses the call.
    if (typeof optionId !== 'string') return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId } };
  }

  onNotification(method: string, params: Json): void {
    const update = method === 'session/update' ? asRecord(params.update) : undefined;
    if (!update) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.said += firstString(asRecord(update.content), ['text']) ?? '';
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      this.onToolCall(update);
    }
  }

  private kindOf(call: Json): ToolKind {
    const name = firstString(call, ['name']) ?? '';
    return KIND_BY_TOOL[name] ?? KIND_BY_ACP_KIND[String(call.kind)] ?? 'tool';
  }

  private commandOf(call: Json): string {
    return (
      firstString(asRecord(call.args), ['CommandLine']) ??
      firstString(asRecord(call.rawInput), ['CommandLine']) ??
      firstString(call, ['title']) ??
      ''
    );
  }

  private async decideCommand(call: Json): Promise<boolean> {
    const id = firstString(call, ['toolCallId']) ?? '';
    const tool = firstString(call, ['name']) ?? 'run_command';
    const command = this.commandOf(call);
    let decision;
    try {
      decision =
        command.trim() === ''
          ? { allow: false, reason: 'The command was empty.' }
          : await this.task.onCommand!({ command });
    } catch {
      decision = { allow: false, reason: 'Symposium could not decide on this command.' };
    }
    if (decision.allow) {
      this.running.add(id);
      this.task.onEvent?.(toolEvent('command', tool, command));
    } else {
      this.refused.add(id);
      this.refusedCommands.push(command);
      this.task.onEvent?.(deniedCommandEvent(tool, command, decision.reason ?? 'refused'));
    }
    return decision.allow;
  }

  private onToolCall(call: Json): void {
    const id = firstString(call, ['toolCallId']) ?? '';
    const tool = firstString(call, ['name']) ?? 'a tool';
    const kind = this.kindOf(call);
    const done = call.status === 'completed' || call.status === 'failed';

    // Whatever the agent said before reaching for a tool was not its reply.
    if (this.said.trim() !== '') {
      const event = textEvent(this.said);
      if (event) this.task.onEvent?.(event);
      this.lastSaid = this.said;
    }
    this.said = '';

    if (this.refused.has(id) || this.reported.has(id)) return;
    if (kind === 'command') {
      if (!done) return;
      this.reported.add(id);
      const command = this.commandOf(call);
      // `agy` ran this one without asking, as its own settings let it. It is still logged.
      if (!this.running.has(id)) this.task.onEvent?.(toolEvent('command', tool, command));
      const result = asRecord(call.rawOutput);
      const exitCode = typeof result?.exit_code === 'number' ? result.exit_code : undefined;
      this.task.onEvent?.(
        outputEvent(tool, command, {
          output: firstString(result, ['output']) ?? '',
          exitCode,
          failed: call.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
        }),
      );
      return;
    }
    // An edit is reported once it has happened, other tools when first seen.
    if (kind === 'edit' && call.status !== 'completed') return;
    this.reported.add(id);
    const path =
      firstString(asRecord(call.args), ['Path']) ??
      (Array.isArray(call.locations)
        ? firstString(asRecord(call.locations[0]), ['path'])
        : undefined);
    const hasTarget = path !== undefined && kind !== 'search';
    this.task.onEvent?.(
      toolEvent(kind, tool, hasTarget ? displayPath(path, this.task.workingDirectory) : undefined),
    );
  }
}

function explain(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/unknown model|thought_level|invalid.*(model|value)/i.test(message)) {
    return new AdapterError(
      'Antigravity does not accept this model with this effort. Set the effort to Default or choose another model',
      message,
    );
  }
  return new AdapterError(`agy refused the request: ${message}`);
}

/** Sets the session up for the task and runs its one prompt. */
async function converse(
  connection: AcpConnection,
  task: AgentTask,
): Promise<{ stopReason: string }> {
  await connection.call('initialize', {
    protocolVersion: 1,
    // Symposium offers the agent no file or terminal services of its own.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  const session = await connection.call('session/new', {
    cwd: task.workingDirectory,
    mcpServers: [],
  });
  const sessionId = session.sessionId;
  if (typeof sessionId !== 'string') throw new AdapterError('agy did not start a session');

  // `accept-edits` approves edits inside the folder and asks about commands. `default` asks
  // about edits too, and every such question is answered with no.
  await connection.call('session/set_mode', {
    sessionId,
    modeId: task.access === 'edit' ? 'accept-edits' : 'default',
  });
  const { model, effort } = antigravityModel(task);
  if (model && effort) {
    await connection.call('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: model,
    });
  } else if (model) {
    await connection.call('session/set_model', { sessionId, modelId: model });
  }
  if (effort) {
    await connection.call('session/set_config_option', {
      sessionId,
      configId: 'thought_level',
      value: effort,
    });
  }
  const done = await connection.call('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: antigravityPrompt(task) }],
  });
  return { stopReason: typeof done.stopReason === 'string' ? done.stopReason : 'end_turn' };
}

/**
 * Runs one turn through `agy acp`, the Agent Client Protocol server built into `agy`. Unlike
 * print mode it asks before running a command, so the engine can decide each one.
 */
export async function runAntigravityAcp(command: string, original: AgentTask): Promise<AgentReply> {
  // Time spent waiting for the human to allow a command does not count toward the turn.
  const clock = new TurnClock(original.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const task = pausingForApproval(original, clock);
  const turn = new AcpTurn(task);
  // Lets go of a process that stays up after the turn is over.
  const finished = new AbortController();
  let connection: AcpConnection | undefined;
  let conversation: Promise<{ stopReason: string }> | undefined;

  const signals = task.signal ? [task.signal, finished.signal] : [finished.signal];
  let exit: { code: number | null; stderr: string } | undefined;
  try {
    const result = await runProcess({
      command,
      // The sandbox restricts what terminal commands can reach.
      args: ['acp', '--sandbox'],
      cwd: task.workingDirectory,
      signal: AbortSignal.any(signals),
      clock,
      onStart: (stdin) => {
        const opened = new AcpConnection(stdin, {
          onRequest: (method, params) => turn.onRequest(method, params),
          onNotification: (method, params) => turn.onNotification(method, params),
        });
        connection = opened;
        conversation = converse(opened, task);
        // Closing stdin ends the server. If it lingers, it is stopped.
        const wrapUp = (): void => {
          stdin.end();
          setTimeout(() => finished.abort(), EXIT_GRACE_MS).unref();
        };
        conversation.then(wrapUp, wrapUp);
      },
      onStdoutLine: (line) => connection?.onLine(line),
    });
    exit = { code: result.exitCode, stderr: result.stderr };
  } catch (error) {
    // Stopped by Symposium after the turn was over: the conversation holds the outcome.
    if (!(error instanceof CancelledError && finished.signal.aborted && !task.signal?.aborted)) {
      throw error;
    }
  }
  connection?.close(
    new AdapterError(`agy acp exited with code ${exit?.code}`, exit?.stderr.slice(0, 2000)),
  );

  let stopReason: string;
  try {
    stopReason = (await conversation!).stopReason;
  } catch (error) {
    throw explain(error);
  }
  const text = turn.reply || turn.stoppedNote;
  if (!text) throw new AdapterError('agy returned an empty reply');
  const warning =
    stopReason === 'end_turn' ? undefined : `Antigravity stopped early (${stopReason})`;
  return { text, warning, changedFiles: [] };
}
