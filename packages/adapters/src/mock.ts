import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { deniedCommandEvent, outputEvent, toolEvent } from './events.js';
import {
  AdapterError,
  CancelledError,
  type AgentAdapter,
  type AgentEvent,
  type AgentReply,
  type AgentTask,
} from './types.js';

export interface MockReply {
  text: string;
  /** Files to write in the working directory, path -> content. Simulates an agent editing code. */
  files?: Record<string, string>;
  /** Progress to report at the start of the turn, as a streaming provider would. */
  events?: AgentEvent[];
  /**
   * Terminal commands the agent wants to run, in order. Each is put to `task.onCommand` first,
   * as a real provider would. Nothing is really run: an allowed command "prints" its own text.
   */
  commands?: string[];
  delayMs?: number;
  /** Fail the turn with this message instead of replying. */
  error?: string;
  /** What the turn cost, as a provider that reports prices would say. */
  costUsd?: number;
}

export type MockResponder = (task: AgentTask, callIndex: number) => MockReply | Promise<MockReply>;

/** Replies to the last line of the message, so a mock team is easy to follow in the chat. */
export const echoResponder: MockResponder = (task) => {
  const firstLine = task.trigger.trim().split('\n')[0] ?? '';
  const quoted = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return { text: `(mock reply from ${task.agentName}) I read: "${quoted}"`, delayMs: 400 };
};

/**
 * Scripted adapter for tests and for trying Symposium without spending tokens.
 * Give it a list of replies (used in order, the last one repeats) or a function.
 */
export class MockAdapter implements AgentAdapter {
  readonly provider = 'mock' as const;
  readonly calls: AgentTask[] = [];
  /** Every command a scripted reply asked to run, with whether it was allowed. */
  readonly commands: { command: string; allowed: boolean; reason?: string }[] = [];
  private readonly responder: MockResponder;

  constructor(script: MockResponder | MockReply[] = echoResponder) {
    if (Array.isArray(script)) {
      if (script.length === 0) throw new Error('MockAdapter needs at least one reply');
      this.responder = (_task, index) => script[Math.min(index, script.length - 1)]!;
    } else {
      this.responder = script;
    }
  }

  async run(task: AgentTask): Promise<AgentReply> {
    const index = this.calls.length;
    this.calls.push(task);
    const reply = await this.responder(task, index);
    for (const event of reply.events ?? []) task.onEvent?.(event);
    for (const command of reply.commands ?? []) await this.runCommand(task, command);

    if (reply.delayMs) {
      try {
        await sleep(reply.delayMs, undefined, { signal: task.signal });
      } catch {
        throw new CancelledError();
      }
    }
    if (task.signal?.aborted) throw new CancelledError();
    if (reply.error) throw new AdapterError(reply.error);

    if (reply.files) {
      if (task.access !== 'edit') {
        throw new AdapterError(`${task.agentName} tried to edit files without edit access`);
      }
      for (const [path, content] of Object.entries(reply.files)) {
        const target = resolve(task.workingDirectory, path);
        if (!target.startsWith(resolve(task.workingDirectory) + sep)) {
          throw new AdapterError(`Refusing to write outside the working directory: ${path}`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    }
    return {
      text: reply.text,
      changedFiles: Object.keys(reply.files ?? {}).sort(),
      ...(reply.costUsd === undefined ? {} : { costUsd: reply.costUsd }),
    };
  }

  private async runCommand(task: AgentTask, command: string): Promise<void> {
    const asked = task.commands !== undefined && task.commands !== 'off' && task.onCommand;
    const decision = asked
      ? await asked({ command })
      : { allow: false, reason: 'This agent has no terminal.' };
    if (task.signal?.aborted) throw new CancelledError();
    this.commands.push({ command, allowed: decision.allow, reason: decision.reason });
    if (decision.allow) {
      task.onEvent?.(toolEvent('command', 'mock', command));
      task.onEvent?.(outputEvent('mock', command, { output: `ran: ${command}`, exitCode: 0 }));
    } else {
      task.onEvent?.(deniedCommandEvent('mock', command, decision.reason ?? 'refused'));
    }
  }
}
