import type { CommandDecision, CommandRequest } from '@symposium/adapters';
import { postMessage, postNotice, setMessageMeta } from '../chat.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../errors.js';
import type { Agent, CommandStatus, Group, Message, MessageMeta } from '../protocol.js';
import { MAX_ALLOWLIST_ENTRIES, settingsOverrides } from '../settings.js';
import { getAgent, updateAgent } from '../store/agents.js';
import { logEvent } from '../store/events.js';
import { allowPatternsFor, decide, needsHuman } from './policy.js';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

type CommandMeta = Extract<MessageMeta, { type: 'command' }>;
export type CommandChoice = 'allow' | 'always' | 'deny';

/** Who or what settled a command. */
type DecidedBy = 'policy' | 'human' | 'timeout' | 'stop';

interface Pending {
  settle: (status: CommandStatus, by: DecidedBy, always?: boolean) => void;
}

/** Where an agent's commands run, and how to say so on the approval card. */
export interface CommandPlace {
  cwd: string;
  /** In words: "Ada's worktree (symposium/ada)". */
  label: string;
}

const REFUSALS: Partial<Record<CommandStatus, string>> = {
  denied: 'The CEO said no to this command. Do not retry it. Carry on without it or ask why.',
  expired: 'Nobody answered in time, so the command was not run. Say so and carry on without it.',
  cancelled: 'You were stopped before the command was decided.',
};

/**
 * Decides every terminal command an agent asks to run: by the policy alone when that settles
 * it, otherwise by putting an approval card in the chat and waiting for the human. Only the
 * agent that asked waits. Every decision is logged.
 */
export class CommandApprovals {
  /** Commands waiting for the human, by the id of their card's message. */
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly ctx: AppContext,
    private readonly timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  ) {}

  async decide(
    group: Group,
    agentId: string,
    place: CommandPlace,
    request: CommandRequest,
    signal?: AbortSignal,
  ): Promise<CommandDecision> {
    // Read afresh for every command: the human may have changed the settings, or chosen
    // "Always allow", since the turn began.
    const agent = getAgent(this.ctx.db, agentId);
    if (!agent || agent.firedAt !== null) {
      return { allow: false, reason: 'You are no longer on the team.' };
    }
    const { command } = request;
    const policy = decide(agent.settings, command, place.cwd);
    const record = (decision: string, by: DecidedBy, extra: Record<string, unknown> = {}) =>
      logEvent(this.ctx.db, {
        groupId: group.id,
        agentId: agent.id,
        kind: 'command.decided',
        detail: {
          command,
          folder: place.label,
          mode: agent.settings.commands,
          decision,
          by,
          ...extra,
        },
      });

    if (policy.verdict !== 'ask') {
      record(policy.verdict === 'allow' ? 'allowed' : 'denied', 'policy', { rule: policy.reason });
      return { allow: policy.verdict === 'allow', reason: policy.reason };
    }
    if (signal?.aborted) {
      record('cancelled', 'stop');
      return { allow: false, reason: REFUSALS.cancelled };
    }

    const meta: CommandMeta = {
      type: 'command',
      status: 'pending',
      agentId: agent.id,
      command,
      folder: place.label,
      reason: policy.reason,
      // A command that always asks cannot be allowed for good, so that is not offered.
      patterns: needsHuman(command, place.cwd) ? [] : allowPatternsFor(command),
    };
    const card = postMessage(this.ctx, {
      groupId: group.id,
      authorKind: 'system',
      body: `${agent.name} wants to run a command in ${place.label}.`,
      meta,
    });

    const { status, by, always } = await new Promise<{
      status: CommandStatus;
      by: DecidedBy;
      always?: boolean;
    }>((resolve) => {
      const timer = setTimeout(() => settle('expired', 'timeout'), this.timeoutMs);
      timer.unref();
      const onStop = (): void => settle('cancelled', 'stop');
      const settle: Pending['settle'] = (settled, settledBy, settledAlways) => {
        if (!this.pending.delete(card.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onStop);
        resolve({ status: settled, by: settledBy, always: settledAlways });
      };
      this.pending.set(card.id, { settle });
      signal?.addEventListener('abort', onStop, { once: true });
    });

    setMessageMeta(this.ctx, card, { ...meta, status, ...(always ? { always: true } : {}) });
    record(status, by, { messageId: card.id, ...(always ? { always: true } : {}) });
    if (status === 'allowed') return { allow: true };
    return { allow: false, reason: REFUSALS[status] ?? 'The command was not allowed.' };
  }

  /** The human's answer to an approval card. Returns the card as it now stands. */
  resolve(group: Group, card: Message, choice: CommandChoice): Message {
    const meta = card.meta;
    if (meta?.type !== 'command') throw badRequest('That message is not a command request');
    if (meta.status !== 'pending') throw conflict(`This command was already ${meta.status}`);
    const waiting = this.pending.get(card.id);
    if (!waiting) {
      // Left over from before a restart: the agent that asked is no longer waiting.
      setMessageMeta(this.ctx, card, { ...meta, status: 'cancelled' });
      throw conflict('The agent is no longer waiting for this answer.');
    }

    const always = choice === 'always' && this.alwaysAllow(group, meta);
    waiting.settle(choice === 'deny' ? 'denied' : 'allowed', 'human', always);
    // `decide` writes the card's final state as soon as it wakes. Answer with the same.
    return {
      ...card,
      meta: {
        ...meta,
        status: choice === 'deny' ? 'denied' : 'allowed',
        ...(always ? { always: true } : {}),
      },
    };
  }

  /** How many commands are waiting for the human. */
  get waiting(): number {
    return this.pending.size;
  }

  /**
   * "Always allow": adds the command's patterns to the agent's allow-list. An agent that asks
   * before every command moves to allow-list mode, or the list would change nothing.
   */
  private alwaysAllow(group: Group, meta: CommandMeta): boolean {
    const agent = getAgent(this.ctx.db, meta.agentId);
    if (!agent || meta.patterns.length === 0) return false;
    const allowlist = [...new Set([...agent.settings.allowlist, ...meta.patterns])];
    if (allowlist.length > MAX_ALLOWLIST_ENTRIES) {
      postNotice(
        this.ctx,
        group.id,
        `${agent.name}'s allow-list is full, so this command was allowed once only.`,
        'warning',
      );
      return false;
    }
    const commands = agent.settings.commands === 'ask' ? 'allowlist' : agent.settings.commands;
    this.saveSettings(agent, { ...agent.settings, allowlist, commands });
    logEvent(this.ctx.db, {
      groupId: group.id,
      agentId: agent.id,
      kind: 'agent.edited',
      detail: { changes: ['allow-list updated'], added: meta.patterns, commands },
    });
    this.ctx.hub.broadcast(group.id, { type: 'agents.changed' });
    const moved =
      commands === agent.settings.commands ? '' : ' and now asks only for other commands';
    postNotice(
      this.ctx,
      group.id,
      `${agent.name} may now always run ${meta.patterns.map((pattern) => `\`${pattern}\``).join(', ')}${moved}.`,
    );
    return true;
  }

  private saveSettings(agent: Agent, settings: Agent['settings']): void {
    updateAgent(this.ctx.db, agent.id, {
      name: agent.name,
      provider: agent.provider,
      model: agent.model,
      role: agent.role,
      instructions: agent.instructions,
      options: agent.options,
      settings: settingsOverrides(agent.role, settings),
    });
  }
}
