import { AdapterError, CancelledError, DEFAULT_TIMEOUT_MS } from '@symposium/adapters';
import { postMessage, postNotice } from '../chat.js';
import type { AppContext } from '../context.js';
import { appendMemory, memoryForPrompt, readMemory } from '../memory.js';
import { projectForPrompt, readProjectFile } from '../project-file.js';
import type { Agent, Group, HireRequest, Message } from '../protocol.js';
import { loadRoleText, roleAccess } from '../roles.js';
import { getAgent, listAgents } from '../store/agents.js';
import { logEvent } from '../store/events.js';
import { getGroup } from '../store/groups.js';
import { listMessages } from '../store/messages.js';
import { validateHire } from '../team.js';
import { parseMentions } from './mentions.js';
import { buildPrompt, buildSystemPrompt, LEAD_HISTORY } from './prompt.js';
import { parseReplyBlocks } from './reply-blocks.js';

/** Where an agent works during a turn. Workers get their own worktree (see git/workspaces.ts). */
export interface Workspace {
  cwd: string;
  branch?: string;
}

export interface RunnerHooks {
  /** Gives the agent somewhere to work. */
  prepareWorkspace(group: Group, agent: Agent): Promise<Workspace>;
  /** Called after each successful turn, e.g. to commit a worker's changes and post the diff. */
  afterTurn(group: Group, agent: Agent, workspace: Workspace, reply: Message): Promise<void>;
  /** Called when a run ends without being stopped, e.g. to let the scribe update project.md. */
  afterRun(group: Group): Promise<void>;
}

interface Turn {
  agent: Agent;
  trigger: Message;
}

interface Run {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Runs the team's turns. The engine, not a model, decides turn order and when to stop:
 * - A human message goes to the agents it @mentions, or to the lead if it mentions nobody.
 * - An agent's reply goes to the agents it @mentions.
 * - Each hand-off between agents is a round. After the group's round limit the team waits for the human.
 * - A new human message or the Stop button cancels the current run.
 * Agents take turns one at a time, in mention order.
 */
export class TeamRunner {
  private readonly runs = new Map<string, Run>();
  /** Per-group queue so starting and stopping runs never interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ctx: AppContext,
    private readonly hooks: RunnerHooks,
  ) {}

  isRunning(groupId: string): boolean {
    return this.runs.has(groupId);
  }

  /** Starts a run for a new human message, cancelling any run in progress. */
  onHumanMessage(group: Group, message: Message): Promise<void> {
    return this.serialize(group.id, async () => {
      const interrupted = await this.cancel(group.id);
      if (interrupted) {
        postNotice(this.ctx, group.id, 'Stopped the current work to follow your new message.');
      }
      const turns = this.recipientsOfHuman(group, message);
      if (turns.length > 0) this.start(group.id, turns);
    });
  }

  /** Cancels the group's run, if any, and waits for it to wind down. Returns whether one was running. */
  stop(groupId: string): Promise<boolean> {
    return this.serialize(groupId, () => this.cancel(groupId));
  }

  private async cancel(groupId: string): Promise<boolean> {
    const run = this.runs.get(groupId);
    if (!run) return false;
    run.controller.abort();
    await run.done;
    return true;
  }

  private serialize<T>(groupId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(groupId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.locks.set(groupId, next);
    return next;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((groupId) => this.stop(groupId)));
  }

  /** Resolves when the group has no queued or running work. For tests. */
  async waitForIdle(groupId: string): Promise<void> {
    for (;;) {
      await this.locks.get(groupId)?.catch(() => undefined);
      const run = this.runs.get(groupId);
      if (!run) return;
      await run.done;
    }
  }

  private recipientsOfHuman(group: Group, message: Message): Turn[] {
    const team = listAgents(this.ctx.db, group.id).filter((agent) => agent.role !== 'scribe');
    const mentioned = parseMentions(message.body, team);
    if (mentioned.length > 0) return mentioned.map((agent) => ({ agent, trigger: message }));

    const lead = team.find((agent) => agent.role === 'lead');
    if (lead) return [{ agent: lead, trigger: message }];

    if (team.length > 0) {
      postNotice(
        this.ctx,
        group.id,
        'No one was mentioned and the team has no lead. Mention a teammate with @name, or hire a lead to route work.',
      );
    }
    return [];
  }

  private start(groupId: string, firstTurns: Turn[]): void {
    const controller = new AbortController();
    const done = this.execute(groupId, firstTurns, controller.signal)
      .catch((error: unknown) => {
        if (!(error instanceof CancelledError)) {
          postNotice(this.ctx, groupId, `The run failed: ${String(error)}`, 'error');
        }
      })
      .finally(() => {
        this.runs.delete(groupId);
        this.ctx.hub.broadcast(groupId, { type: 'run.status', running: false });
      });
    this.runs.set(groupId, { controller, done });
    this.ctx.hub.broadcast(groupId, { type: 'run.status', running: true });
  }

  private async execute(groupId: string, firstTurns: Turn[], signal: AbortSignal): Promise<void> {
    let wave = firstTurns;
    let round = 0;

    while (wave.length > 0) {
      const group = getGroup(this.ctx.db, groupId)!;
      if (round > group.maxRounds) {
        const waiting = wave.map((turn) => turn.agent.name).join(', ');
        postNotice(
          this.ctx,
          groupId,
          `Round limit reached (${group.maxRounds}). The team is waiting for you before ${waiting} continue${wave.length === 1 ? 's' : ''}. Reply to carry on, or raise the limit.`,
          'warning',
        );
        return;
      }

      const next: Turn[] = [];
      for (const turn of wave) {
        if (signal.aborted) throw new CancelledError();
        const agent = getAgent(this.ctx.db, turn.agent.id);
        if (!agent || agent.firedAt !== null) continue;

        const reply = await this.runTurn(group, agent, turn.trigger, signal);
        if (!reply) continue;
        const team = listAgents(this.ctx.db, groupId).filter(
          (member) => member.role !== 'scribe' && member.id !== agent.id,
        );
        for (const mentioned of parseMentions(reply.body, team)) {
          if (!next.some((queued) => queued.agent.id === mentioned.id)) {
            next.push({ agent: mentioned, trigger: reply });
          }
        }
      }
      wave = next;
      round++;
    }

    if (!signal.aborted) await this.hooks.afterRun(getGroup(this.ctx.db, groupId)!);
  }

  /** One agent turn. Returns the agent's message, or undefined if the turn failed. */
  private async runTurn(
    group: Group,
    agent: Agent,
    trigger: Message,
    signal: AbortSignal,
  ): Promise<Message | undefined> {
    const { ctx } = this;
    ctx.hub.broadcast(group.id, { type: 'agent.activity', agentId: agent.id, activity: 'working' });
    const started = Date.now();
    try {
      const workspace = await this.hooks.prepareWorkspace(group, agent);
      const access = roleAccess(agent.role);
      const promptInput = {
        group,
        agent,
        team: listAgents(ctx.db, group.id),
        everyone: listAgents(ctx.db, group.id, { includeFired: true }),
        roleText: await loadRoleText(ctx.rolesDir, agent.role),
        access,
        branch: workspace.branch,
        projectMd: projectForPrompt(await readProjectFile(group.folderPath)),
        memory: memoryForPrompt(await readMemory(ctx.dataDir, agent.id)),
        history: listMessages(ctx.db, group.id, { limit: Math.max(LEAD_HISTORY, 200) }),
        trigger,
      };

      const result = await ctx.createAdapter(agent).run({
        agentName: agent.name,
        model: agent.model,
        systemPrompt: buildSystemPrompt(promptInput),
        prompt: buildPrompt(promptInput),
        trigger: trigger.body,
        workingDirectory: workspace.cwd,
        access,
        signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      const parsed = parseReplyBlocks(result.text);
      await appendMemory(ctx.dataDir, agent.id, parsed.memoryNotes, group.name);
      const reply = postMessage(ctx, {
        groupId: group.id,
        authorKind: 'agent',
        authorAgentId: agent.id,
        body: parsed.text || '(no message)',
      });

      logEvent(ctx.db, {
        groupId: group.id,
        agentId: agent.id,
        kind: 'agent.turn',
        detail: {
          provider: agent.provider,
          model: agent.model,
          triggerMessageId: trigger.id,
          replyMessageId: reply.id,
          durationMs: Date.now() - started,
          costUsd: result.costUsd,
          changedFiles: result.changedFiles,
          memoryNotes: parsed.memoryNotes.length,
        },
      });

      if (result.warning) postNotice(ctx, group.id, `${agent.name}: ${result.warning}`, 'warning');
      for (const problem of parsed.problems) postNotice(ctx, group.id, problem, 'warning');
      if (agent.role === 'lead') this.postHireProposals(group, agent, parsed.hireProposals);

      try {
        await this.hooks.afterTurn(group, agent, workspace, reply);
      } catch (error) {
        postNotice(
          ctx,
          group.id,
          `Could not record ${agent.name}'s work: ${String(error)}`,
          'error',
        );
      }
      return reply;
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) throw new CancelledError();
      const details = error instanceof AdapterError && error.details ? `\n\n${error.details}` : '';
      const reason = error instanceof Error ? error.message : String(error);
      postNotice(ctx, group.id, `${agent.name} could not finish: ${reason}${details}`, 'error');
      logEvent(ctx.db, {
        groupId: group.id,
        agentId: agent.id,
        kind: 'agent.turn_failed',
        detail: { reason, durationMs: Date.now() - started },
      });
      return undefined;
    } finally {
      ctx.hub.broadcast(group.id, { type: 'agent.activity', agentId: agent.id, activity: 'idle' });
    }
  }

  private postHireProposals(group: Group, lead: Agent, proposals: unknown[]): void {
    for (const proposal of proposals) {
      let hire: HireRequest;
      try {
        hire = validateHire(proposal as HireRequest);
      } catch (error) {
        postNotice(
          this.ctx,
          group.id,
          `${lead.name} proposed a hire that can't be used: ${(error as Error).message}`,
          'warning',
        );
        continue;
      }
      postMessage(this.ctx, {
        groupId: group.id,
        authorKind: 'system',
        body: `${lead.name} proposes hiring ${hire.name} as ${hire.role} (${hire.provider} · ${hire.model}).`,
        meta: { type: 'hire-proposal', status: 'pending', proposedBy: lead.id, hire },
      });
    }
  }
}
