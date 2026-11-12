import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
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
  delayMs?: number;
  /** Fail the turn with this message instead of replying. */
  error?: string;
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
    return { text: reply.text, changedFiles: Object.keys(reply.files ?? {}).sort() };
  }
}
