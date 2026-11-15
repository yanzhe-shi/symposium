import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AdapterError,
  CancelledError,
  DEFAULT_TIMEOUT_MS,
  PROVIDERS,
  type AgentEvent,
  type CommandDecision,
  type CommandRequest,
} from '@symposium/adapters';
import { postMessage, postNotice, setMessageMeta } from '../chat.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict } from '../errors.js';
import { appendMemory, memoryForPrompt, readMemory } from '../memory.js';
import { projectForPrompt, readProjectFile } from '../project-file.js';
import type {
  Agent,
  Group,
  HireRequest,
  Message,
  ReviewResult,
  RoleDraft,
  TeamStatus,
  WorktreeChanges,
} from '../protocol.js';
import { parseRoleFile, roleIdFor, validateRoleDraft } from '../roles.js';
import { getAgent, listAgents } from '../store/agents.js';
import { logEvent } from '../store/events.js';
import { getGroup } from '../store/groups.js';
import {
  getMessage,
  listMessages,
  listPendingPlans,
  threadHasApprovedPlan,
} from '../store/messages.js';
import { roleName, validateHire } from '../team.js';
import { parseCommand } from './commands.js';
import { parseMentions } from './mentions.js';
import { PacedTask } from './paced.js';
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
  /**
   * Called after each successful turn, e.g. to commit a worker's changes, post the diff and
   * run the project's check on it. Returns the diff's message when the turn changed files.
   * The reply is handed on only when this has finished, so whoever reads it next also sees
   * how the check went. `signal` fires when the agent is stopped.
   */
  afterTurn(
    group: Group,
    agent: Agent,
    workspace: Workspace,
    reply: Message,
    signal: AbortSignal,
  ): Promise<Message | undefined>;
  /** Called once the whole group has been idle for a while, to let the scribe update project.md. */
  onIdle(group: Group, signal: AbortSignal): Promise<void>;
  /**
   * The agent's uncommitted work, for the live view of a turn in progress. Undefined when the
   * agent has no worktree of its own. Must not change anything.
   */
  liveChanges?(
    group: Group,
    agent: Agent,
    workspace: Workspace,
  ): Promise<WorktreeChanges | undefined>;
  /**
   * Decides a terminal command the agent wants to run during its turn. May take as long as a
   * human takes to answer. Without this hook no agent gets a terminal.
   */
  decideCommand?(
    group: Group,
    agent: Agent,
    workspace: Workspace,
    request: CommandRequest,
    signal: AbortSignal,
  ): Promise<CommandDecision>;
}

/** A message waiting for an agent's next turn. */
interface InboxItem {
  trigger: Message;
  /** The human message that started the conversation this belongs to. */
  threadId: number;
  /** How many hand-offs deep in the thread the agent's answer will be. */
  round: number;
  /**
   * True for an answer that came back by itself: the author mentioned nobody, so the engine
   * returned it to whoever had asked. Such an answer is not a request, so the answer to it is
   * not returned in turn. That is what keeps two agents from thanking each other for ever.
   */
  returned: boolean;
  /** Whether the UI was told this message is waiting. */
  announced: boolean;
  /** Order of arrival across the group, so waiting agents start first come, first served. */
  seq: number;
}

interface ActiveTurn {
  controller: AbortController;
  /** Settles when the turn has fully wound down, whether it finished, failed or was cancelled. */
  done: Promise<void>;
}

/** One agent's queue of messages. The agent works through it one turn at a time. */
interface AgentInbox {
  queue: InboxItem[];
  turn?: ActiveTurn;
  /** Set by `/now`: this agent starts before others that are waiting for a free slot. */
  urgent: boolean;
  /** The next turn replaces one that `/now` cut short. */
  interrupted: boolean;
}

/** A review the engine asks for by itself: a reviewer judges a worker's new change. */
interface ReviewJob {
  worker: Agent;
  /** The diff's message. */
  card: Message;
  /** The worker's worktree, which the reviewer reads. */
  cwd: string;
}

/** What a finished turn left behind. */
interface TurnResult {
  reply: Message;
  workspace: Workspace;
  /** The diff's message, when the turn changed files. */
  change?: Message;
  /** A reviewer's verdict, from a review turn. */
  verdict?: 'approved' | 'changes';
}

interface ScribeJob {
  controller: AbortController;
  /** True during the quiet period before the scribe starts. */
  waiting: boolean;
  done: Promise<void>;
}

interface GroupWork {
  inboxes: Map<string, AgentInbox>;
  scribe?: ScribeJob;
  /** The group went idle again while the scribe was writing, so it should run once more. */
  scribeAgain: boolean;
  /** True while Stop all winds the group down, so turn endings don't wake the scribe. */
  stopping: boolean;
  /** The last `run.status` the UI was sent. */
  announcedRunning: boolean;
  /** Reviewers that are on a review turn right now. Those turns are not in any inbox. */
  reviewing: Set<string>;
  /** Per reviewer, how to stop its reviews: the one going on and the ones waiting behind it. */
  reviewStops: Map<string, Set<AbortController>>;
  /** Per reviewer, the end of its line of reviews. A reviewer does one at a time. */
  reviewQueue: Map<string, Promise<void>>;
}

export interface RunnerOptions {
  /** How long the group must stay idle before the scribe updates project.md. */
  scribeDelayMs?: number;
  /** The shortest time between two pushes of one agent's live diff. */
  liveChangesIntervalMs?: number;
}

/**
 * Who reviews a change: a reviewer on another provider than its author when there is one, so a
 * different model looks at it; failing that one on another model; failing that any reviewer.
 */
export function pickReviewer(team: Agent[], author: Agent): Agent | undefined {
  const reviewers = team.filter(
    (agent) => agent.role === 'reviewer' && agent.firedAt === null && agent.id !== author.id,
  );
  return (
    reviewers.find((agent) => agent.provider !== author.provider) ??
    reviewers.find((agent) => agent.model !== author.model) ??
    reviewers[0]
  );
}

/** "Ada", "Ada and Bo", "Ada, Bo and Cy". */
function listNames(agents: Agent[]): string {
  const names = agents.map((agent) => agent.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The audit log's name for one tool call inside a turn. */
export const AGENT_TOOL_EVENT = 'agent.tool';

export const DEFAULT_SCRIBE_DELAY_MS = 30_000;
export const DEFAULT_LIVE_CHANGES_INTERVAL_MS = 1000;

/**
 * Runs the team's turns. The engine, not a model, decides who works when and when to stop:
 * - Every agent has an inbox and works through it one turn at a time. Different agents work in
 *   parallel, up to the group's cap.
 * - A human message goes to the agents it @mentions, or to the lead if it mentions nobody. It
 *   never cancels work: a busy agent gets it, with anything else that arrived, in its next turn.
 * - An agent's reply goes to the agents it @mentions. A reply that mentions nobody goes back to
 *   the teammates who asked for it. The lead's goes to the human only.
 * - Every human message starts a thread. Each hand-off between agents in a thread is a round;
 *   past the group's round limit that thread waits for the human. Other threads carry on.
 * - While the group asks for plan approval, the lead's first hand-off in a thread is held until
 *   the human approves it. After that the lead hands work on freely in that thread.
 * - Work stops only when the human asks: Stop all, Stop on one agent, `/stop` or `/now`.
 * - A worker's new change is reviewed before its report is handed on, while the group asks for
 *   that and has a reviewer: the engine gives the reviewer one turn on it, outside the inboxes.
 * - When the whole group has been idle for a while, the scribe updates project.md.
 */
export class TeamRunner {
  private readonly groups = new Map<string, GroupWork>();
  private readonly scribeDelayMs: number;
  private readonly liveChangesIntervalMs: number;
  private nextSeq = 1;

  constructor(
    private readonly ctx: AppContext,
    private readonly hooks: RunnerHooks,
    options: RunnerOptions = {},
  ) {
    this.scribeDelayMs = options.scribeDelayMs ?? DEFAULT_SCRIBE_DELAY_MS;
    this.liveChangesIntervalMs = options.liveChangesIntervalMs ?? DEFAULT_LIVE_CHANGES_INTERVAL_MS;
  }

  /**
   * True while anyone on the team is working or has messages waiting. The scribe's housekeeping
   * after the team goes quiet does not count; its own activity shows that.
   */
  isRunning(groupId: string): boolean {
    const work = this.groups.get(groupId);
    return work !== undefined && this.hasTeamWork(work);
  }

  /** What every active agent is doing, for a UI that just connected. */
  status(groupId: string): TeamStatus {
    const work = this.groups.get(groupId);
    const scribeWorking = work?.scribe?.waiting === false;
    return {
      running: this.isRunning(groupId),
      agents: listAgents(this.ctx.db, groupId).map((agent) => {
        const inbox = work?.inboxes.get(agent.id);
        const working =
          agent.role === 'scribe'
            ? scribeWorking
            : inbox?.turn !== undefined || work?.reviewing.has(agent.id) === true;
        return {
          agentId: agent.id,
          activity: working ? 'working' : 'idle',
          queuedMessageIds: inbox?.queue.map((item) => item.trigger.id) ?? [],
        };
      }),
    };
  }

  /** Routes a new human message. Nothing in progress is cancelled unless the message says so. */
  onHumanMessage(group: Group, message: Message): void {
    const command = parseCommand(message.body);
    if (command === 'stop') {
      this.onStopCommand(group, message).catch((error: unknown) => {
        postNotice(this.ctx, group.id, `Could not stop: ${String(error)}`, 'error');
      });
      return;
    }

    const urgent = command === 'now';
    for (const agent of this.recipientsOfHuman(group, message)) {
      const turn = this.groups.get(group.id)?.inboxes.get(agent.id)?.turn;
      this.enqueue(
        group.id,
        agent.id,
        { trigger: message, threadId: message.id, round: 0, returned: false },
        urgent,
      );
      // `/now` cuts short the turn that was already going. An idle agent has simply started.
      if (urgent && turn) this.interrupt(group, agent, turn);
    }
    // The scribe has no inbox: mentioning it asks for a project.md update right away.
    if (this.mentionsScribe(group, message)) this.scheduleScribe(group.id, 0);
  }

  /** Cancels everything in the group and empties every inbox. Returns whether anything was going on. */
  async stopGroup(groupId: string): Promise<boolean> {
    const work = this.groups.get(groupId);
    if (!work) return false;
    const stopped = this.hasTeamWork(work) || work.scribe?.waiting === false;
    const winding: Promise<void>[] = [];

    work.stopping = true;
    for (const [agentId, inbox] of work.inboxes) {
      this.clearInbox(groupId, agentId, inbox);
      if (inbox.turn) {
        inbox.turn.controller.abort();
        winding.push(inbox.turn.done);
      }
    }
    const scribe = work.scribe;
    if (scribe) {
      work.scribe = undefined;
      work.scribeAgain = false;
      scribe.controller.abort();
      winding.push(scribe.done);
    }
    await Promise.all(winding);
    work.stopping = false;
    this.syncStatus(groupId);

    if (stopped) {
      logEvent(this.ctx.db, { groupId, kind: 'team.stopped' });
      postNotice(this.ctx, groupId, 'You stopped the team.');
    }
    return stopped;
  }

  /** Cancels one agent's turn and empties its inbox. Returns whether there was anything to stop. */
  async stopAgent(groupId: string, agent: Agent, announce = true): Promise<boolean> {
    const work = this.groups.get(groupId);
    if (!work) return false;
    let stopped = false;
    const winding: Promise<void>[] = [];

    const scribe = work.scribe;
    // A scribe that is only waiting for quiet is left alone: there is nothing to stop yet.
    if (agent.role === 'scribe' && scribe && !scribe.waiting) {
      stopped = true;
      work.scribe = undefined;
      work.scribeAgain = false;
      scribe.controller.abort();
      winding.push(scribe.done);
    }
    // Reviews run inside the turn of the worker they are about, which winds them down.
    const reviews = work.reviewStops.get(agent.id);
    if (reviews && reviews.size > 0) {
      stopped = true;
      for (const review of reviews) review.abort();
    }
    const inbox = work.inboxes.get(agent.id);
    if (inbox) {
      stopped ||= inbox.queue.length > 0 || inbox.turn !== undefined;
      this.clearInbox(groupId, agent.id, inbox);
      if (inbox.turn) {
        inbox.turn.controller.abort();
        winding.push(inbox.turn.done);
      }
    }
    await Promise.all(winding);
    this.syncStatus(groupId);

    if (stopped) {
      logEvent(this.ctx.db, { groupId, agentId: agent.id, kind: 'agent.stopped' });
      if (announce) postNotice(this.ctx, groupId, `You stopped ${agent.name}.`);
    }
    return stopped;
  }

  /** Stops every group. Called when the server shuts down. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.groups.keys()].map((groupId) => this.dropGroup(groupId)));
  }

  /**
   * Stops a group's work without a word in the chat and forgets the group. Used when the
   * server shuts down and when the human deletes the group.
   */
  async dropGroup(groupId: string): Promise<void> {
    const work = this.groups.get(groupId);
    if (!work) return;
    work.stopping = true;
    const winding: Promise<void>[] = [];
    for (const inbox of work.inboxes.values()) {
      inbox.queue = [];
      inbox.turn?.controller.abort();
      if (inbox.turn) winding.push(inbox.turn.done);
    }
    if (work.scribe) {
      work.scribe.controller.abort();
      winding.push(work.scribe.done);
    }
    await Promise.all(winding);
    this.groups.delete(groupId);
  }

  /** Resolves when the group has nothing running, waiting or scheduled. For tests. */
  async waitForIdle(groupId: string): Promise<void> {
    for (;;) {
      const work = this.groups.get(groupId);
      const pending: Promise<void>[] = [];
      for (const inbox of work?.inboxes.values() ?? []) {
        if (inbox.turn) pending.push(inbox.turn.done);
      }
      if (work?.scribe) pending.push(work.scribe.done);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /** Starts waiting agents while the group is under its cap on agents working at once. */
  pump(groupId: string): void {
    const work = this.groups.get(groupId);
    const group = getGroup(this.ctx.db, groupId);
    if (!work || !group) return;
    for (;;) {
      const inboxes = [...work.inboxes.entries()];
      const working = inboxes.filter(([, inbox]) => inbox.turn).length;
      if (working >= group.maxParallel) break;
      const waiting = inboxes
        .filter(([, inbox]) => !inbox.turn && inbox.queue.length > 0)
        .sort(
          ([, a], [, b]) =>
            Number(b.urgent) - Number(a.urgent) || a.queue[0]!.seq - b.queue[0]!.seq,
        );
      const next = waiting[0];
      if (!next) break;
      this.startTurn(groupId, work, next[0], next[1]);
    }
    this.syncStatus(groupId);
  }

  private workOf(groupId: string): GroupWork {
    let work = this.groups.get(groupId);
    if (!work) {
      work = {
        inboxes: new Map(),
        scribeAgain: false,
        stopping: false,
        announcedRunning: false,
        reviewing: new Set(),
        reviewStops: new Map(),
        reviewQueue: new Map(),
      };
      this.groups.set(groupId, work);
    }
    return work;
  }

  /** True while an agent other than the scribe is working or has messages waiting. */
  private hasTeamWork(work: GroupWork): boolean {
    for (const inbox of work.inboxes.values()) {
      if (inbox.turn || inbox.queue.length > 0) return true;
    }
    return false;
  }

  private syncStatus(groupId: string): void {
    const work = this.groups.get(groupId);
    if (!work) return;
    const running = this.isRunning(groupId);
    if (running === work.announcedRunning) return;
    work.announcedRunning = running;
    this.ctx.hub.broadcast(groupId, { type: 'run.status', running });
  }

  private announceQueue(groupId: string, agentId: string, inbox: AgentInbox): void {
    for (const item of inbox.queue) item.announced = true;
    this.ctx.hub.broadcast(groupId, {
      type: 'agent.queue',
      agentId,
      queuedMessageIds: inbox.queue.map((item) => item.trigger.id),
    });
  }

  private clearInbox(groupId: string, agentId: string, inbox: AgentInbox): void {
    inbox.urgent = false;
    inbox.interrupted = false;
    if (inbox.queue.length === 0) return;
    inbox.queue = [];
    this.announceQueue(groupId, agentId, inbox);
  }

  /** Puts a message in an agent's inbox. An idle agent starts on it at once. */
  private enqueue(
    groupId: string,
    agentId: string,
    message: Pick<InboxItem, 'trigger' | 'threadId' | 'round' | 'returned'>,
    urgent = false,
  ): void {
    const work = this.workOf(groupId);
    let inbox = work.inboxes.get(agentId);
    if (!inbox) {
      inbox = { queue: [], urgent: false, interrupted: false };
      work.inboxes.set(agentId, inbox);
    }
    const item: InboxItem = { ...message, announced: false, seq: this.nextSeq++ };
    if (urgent) {
      inbox.queue.unshift(item);
      inbox.urgent = true;
    } else {
      inbox.queue.push(item);
    }
    this.pump(groupId);
    // Still there after pumping: the agent is busy, or the group is at its cap.
    if (inbox.queue.includes(item)) this.announceQueue(groupId, agentId, inbox);
  }

  /** `/now`: cuts the agent's current turn short. Its inbox, with the urgent message first, runs next. */
  private interrupt(group: Group, agent: Agent, turn: ActiveTurn): void {
    const inbox = this.groups.get(group.id)?.inboxes.get(agent.id);
    if (!inbox || inbox.turn !== turn || turn.controller.signal.aborted) return;
    inbox.interrupted = true;
    turn.controller.abort();
    logEvent(this.ctx.db, { groupId: group.id, agentId: agent.id, kind: 'agent.interrupted' });
    postNotice(this.ctx, group.id, `You interrupted ${agent.name} with an urgent message.`);
  }

  private async onStopCommand(group: Group, message: Message): Promise<void> {
    const targets = parseMentions(message.body, listAgents(this.ctx.db, group.id));
    if (targets.length === 0) {
      if (!(await this.stopGroup(group.id))) postNotice(this.ctx, group.id, 'Nothing was running.');
      return;
    }
    for (const agent of targets) {
      if (!(await this.stopAgent(group.id, agent))) {
        postNotice(this.ctx, group.id, `${agent.name} was not working on anything.`);
      }
    }
  }

  private mentionsScribe(group: Group, message: Message): boolean {
    const scribe = listAgents(this.ctx.db, group.id).filter((agent) => agent.role === 'scribe');
    return parseMentions(message.body, scribe).length > 0;
  }

  private recipientsOfHuman(group: Group, message: Message): Agent[] {
    const team = listAgents(this.ctx.db, group.id).filter((agent) => agent.role !== 'scribe');
    const mentioned = parseMentions(message.body, team);
    if (mentioned.length > 0) return mentioned;
    if (this.mentionsScribe(group, message)) return [];

    const lead = team.find((agent) => agent.role === 'lead');
    if (lead) return [lead];

    if (team.length > 0) {
      postNotice(
        this.ctx,
        group.id,
        'No one was mentioned and the team has no lead. Mention a teammate with @name, or hire a lead to route work.',
      );
    }
    return [];
  }

  /** Hands the agent everything in its inbox as one turn. */
  private startTurn(groupId: string, work: GroupWork, agentId: string, inbox: AgentInbox): void {
    const items = inbox.queue;
    const interrupted = inbox.interrupted;
    inbox.queue = [];
    inbox.urgent = false;
    inbox.interrupted = false;

    // The group is busy again, so a scribe update that was waiting for quiet starts over later.
    if (work.scribe?.waiting) {
      work.scribe.controller.abort();
      work.scribe = undefined;
    }
    const waited = items.filter((item) => item.announced);
    for (const item of waited) {
      this.ctx.hub.broadcast(groupId, {
        type: 'message.delivered',
        messageId: item.trigger.id,
        agentId,
      });
    }
    if (waited.length > 0) this.announceQueue(groupId, agentId, inbox);

    const controller = new AbortController();
    const turn: ActiveTurn = { controller, done: Promise.resolve() };
    inbox.turn = turn;
    turn.done = this.runInbox(groupId, agentId, items, interrupted, controller.signal)
      .catch((error: unknown) => {
        if (!(error instanceof CancelledError)) {
          postNotice(this.ctx, groupId, `A turn failed: ${String(error)}`, 'error');
        }
      })
      .finally(() => {
        inbox.turn = undefined;
        this.pump(groupId);
        if (!work.stopping && !this.hasTeamWork(work)) {
          this.scheduleScribe(groupId, this.scribeDelayMs);
        }
      });
  }

  private async runInbox(
    groupId: string,
    agentId: string,
    items: InboxItem[],
    interrupted: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const group = getGroup(this.ctx.db, groupId);
    const agent = getAgent(this.ctx.db, agentId);
    if (!group || !agent || agent.firedAt !== null) return;

    // The reply joins the newest thread among the messages it answers. Within that thread it
    // takes the deepest round, so batching can never be used to dodge the round limit.
    const threadId = Math.max(...items.map((item) => item.threadId));
    const round = Math.max(
      ...items.filter((item) => item.threadId === threadId).map((item) => item.round),
    );
    const triggers = items.map((item) => item.trigger).sort((a, b) => a.id - b.id);

    const done = await this.runTurn(
      group,
      agent,
      { triggers, threadId, round, interrupted },
      signal,
    );
    // A stopped agent hands nothing on, even if its reply got out just before the stop.
    if (!done || signal.aborted) return;
    // A new change is reviewed first, so whoever gets the report also gets the verdict.
    if (done.change)
      await this.reviewChange(groupId, agent, done, triggers, threadId, round, signal);
    if (signal.aborted) return;
    this.routeReply(groupId, agent, done.reply, items, threadId, round);
  }

  /**
   * Gives a reviewer one turn on a worker's new change, and writes the verdict on the diff.
   * The engine decides that this happens and who reviews; the reviewer decides the verdict.
   * The review is not handed on to anyone: the lead, or the human, acts on it.
   */
  private async reviewChange(
    groupId: string,
    worker: Agent,
    done: TurnResult,
    asked: Message[],
    threadId: number,
    round: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { db } = this.ctx;
    // Read now: the human may have changed the setting or decided the diff since.
    const group = getGroup(db, groupId);
    const card = done.change && getMessage(db, done.change.id);
    if (!group?.autoReview || card?.meta?.type !== 'diff' || card.meta.status !== 'pending') return;
    // A change that fails the project's check goes back to its author first.
    if (card.meta.check && card.meta.check.status !== 'passed') return;
    const reviewer = pickReviewer(listAgents(db, groupId), worker);
    if (!reviewer) return;

    const work = this.workOf(groupId);
    // Stopping the worker stops its review. So does stopping the reviewer.
    const own = new AbortController();
    const stop = AbortSignal.any([signal, own.signal]);
    const stops = work.reviewStops.get(reviewer.id) ?? new Set<AbortController>();
    work.reviewStops.set(reviewer.id, stops);
    stops.add(own);
    this.stampReview(card.id, { reviewerId: reviewer.id, status: 'running' });

    const review = async (): Promise<TurnResult | undefined> => {
      if (stop.aborted) throw new CancelledError();
      work.reviewing.add(reviewer.id);
      try {
        return await this.runTurn(
          group,
          reviewer,
          {
            triggers: [...asked, done.reply, card],
            threadId,
            round,
            interrupted: false,
            review: { worker, card, cwd: done.workspace.cwd },
          },
          stop,
        );
      } finally {
        work.reviewing.delete(reviewer.id);
      }
    };
    // A reviewer does one review at a time, in the order the changes came in.
    const turn = (work.reviewQueue.get(reviewer.id) ?? Promise.resolve()).then(review);
    work.reviewQueue.set(
      reviewer.id,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );

    let result: ReviewResult = { reviewerId: reviewer.id, status: 'failed' };
    try {
      const reviewed = await turn;
      if (reviewed) {
        result = {
          reviewerId: reviewer.id,
          status: reviewed.verdict ?? 'unclear',
          messageId: reviewed.reply.id,
        };
      }
    } catch (error) {
      if (error instanceof CancelledError) result.status = 'stopped';
      else postNotice(this.ctx, groupId, `The review failed: ${String(error)}`, 'error');
    } finally {
      stops.delete(own);
    }
    this.stampReview(card.id, result);
    logEvent(db, {
      groupId,
      agentId: reviewer.id,
      kind: 'review.done',
      detail: { diffMessageId: card.id, authorId: worker.id, ...result },
    });
  }

  /** Writes a review's state on its diff, as the diff stands now. */
  private stampReview(cardId: number, review: ReviewResult): void {
    const card = getMessage(this.ctx.db, cardId);
    if (card?.meta?.type === 'diff') setMessageMeta(this.ctx, card, { ...card.meta, review });
  }

  /**
   * Hands a reply on, one round deeper in its thread: to the teammates it mentions, or, when it
   * mentions nobody, back to the teammates who asked for it.
   */
  private routeReply(
    groupId: string,
    author: Agent,
    reply: Message,
    answered: InboxItem[],
    threadId: number,
    round: number,
  ): void {
    const group = getGroup(this.ctx.db, groupId)!;
    const team = listAgents(this.ctx.db, groupId).filter(
      (member) => member.role !== 'scribe' && member.id !== author.id,
    );
    const mentioned = parseMentions(reply.body, team);
    const returned = mentioned.length === 0;
    const recipients = returned ? this.askersOf(author, answered, team) : mentioned;
    if (recipients.length === 0) return;

    // The human approves the plan before the lead's work starts. This is the gate.
    if (
      author.role === 'lead' &&
      group.leadAsksFirst &&
      !threadHasApprovedPlan(this.ctx.db, groupId, threadId)
    ) {
      this.holdPlan(group, author, reply, recipients, threadId, round);
      return;
    }
    this.handOn(group, reply, recipients, threadId, round, returned);
  }

  /** Puts a reply in its recipients' inboxes, one round deeper, unless the thread is at its limit. */
  private handOn(
    group: Group,
    reply: Message,
    recipients: Agent[],
    threadId: number,
    round: number,
    returned: boolean,
  ): void {
    const groupId = group.id;
    if (round + 1 > group.maxRounds) {
      const waiting = recipients.map((agent) => agent.name).join(', ');
      postMessage(this.ctx, {
        groupId,
        authorKind: 'system',
        body: `Round limit reached (${group.maxRounds}). ${waiting} ${recipients.length === 1 ? 'is' : 'are'} waiting for you before continuing this thread. Reply to carry on, or raise the limit.`,
        meta: { type: 'notice', level: 'warning' },
        threadId,
      });
      return;
    }
    for (const agent of recipients) {
      this.enqueue(groupId, agent.id, { trigger: reply, threadId, round: round + 1, returned });
    }
  }

  /** Holds the lead's hand-off back and asks the human, with a card in the chat. */
  private holdPlan(
    group: Group,
    lead: Agent,
    reply: Message,
    recipients: Agent[],
    threadId: number,
    round: number,
  ): void {
    const recipientIds = recipients.map((agent) => agent.id);
    postMessage(this.ctx, {
      groupId: group.id,
      authorKind: 'system',
      body: `${lead.name} wants to hand work to ${listNames(recipients)}. Nothing starts until you approve the plan.`,
      meta: {
        type: 'plan',
        status: 'pending',
        leadId: lead.id,
        replyMessageId: reply.id,
        recipientIds,
      },
      threadId,
      round,
    });
    logEvent(this.ctx.db, {
      groupId: group.id,
      agentId: lead.id,
      kind: 'plan.held',
      detail: { replyMessageId: reply.id, threadId, recipientIds },
    });
  }

  /**
   * The human's answer to a plan card. Approving hands the lead's held message to the teammates
   * it names and opens its thread for the lead's later hand-offs. Declining drops the hand-off:
   * the human says what to change, and the lead's next plan gets a card of its own.
   */
  decidePlan(group: Group, card: Message, approve: boolean): Message {
    const meta = card.meta;
    if (meta?.type !== 'plan') throw badRequest('That message is not a plan');
    if (meta.status !== 'pending') throw conflict(`This plan was already ${meta.status}`);
    const lead = getAgent(this.ctx.db, meta.leadId);
    const leadName = lead?.name ?? 'the lead';
    const detail = { cardMessageId: card.id, replyMessageId: meta.replyMessageId };

    if (!approve) {
      logEvent(this.ctx.db, {
        groupId: group.id,
        agentId: meta.leadId,
        kind: 'plan.declined',
        detail,
      });
      postNotice(
        this.ctx,
        group.id,
        `You declined the plan. Nothing was started. Tell ${leadName} what to change.`,
      );
      return setMessageMeta(this.ctx, card, { ...meta, status: 'declined' });
    }

    const updated = this.releasePlan(group, card);
    // One approval covers the thread: a hand-off the lead wrote while this one waited goes out
    // with it, instead of asking the human a second time.
    for (const other of listPendingPlans(this.ctx.db, group.id, card.threadId!)) {
      this.releasePlan(group, other);
    }
    return updated;
  }

  /** Marks a held plan approved and hands the lead's message on to whoever it names. */
  private releasePlan(group: Group, card: Message): Message {
    const meta = card.meta;
    if (meta?.type !== 'plan') throw badRequest('That message is not a plan');
    const detail = { cardMessageId: card.id, replyMessageId: meta.replyMessageId };
    const reply = getMessage(this.ctx.db, meta.replyMessageId);
    if (!reply || card.threadId === null) throw conflict('The message this plan held is gone.');
    const team = listAgents(this.ctx.db, group.id);
    const recipients = team.filter(
      (agent) => agent.role !== 'scribe' && meta.recipientIds.includes(agent.id),
    );
    const updated = setMessageMeta(this.ctx, card, { ...meta, status: 'approved' });
    logEvent(this.ctx.db, {
      groupId: group.id,
      agentId: meta.leadId,
      kind: 'plan.approved',
      detail,
    });
    const gone = meta.recipientIds.length - recipients.length;
    if (gone > 0) {
      postNotice(
        this.ctx,
        group.id,
        `${gone === 1 ? 'One teammate' : `${gone} teammates`} named in the plan ${gone === 1 ? 'is' : 'are'} no longer on the team and ${gone === 1 ? 'was' : 'were'} not asked.`,
        'warning',
      );
    }
    if (recipients.length > 0) {
      this.handOn(group, reply, recipients, card.threadId, card.round ?? 0, false);
    }
    return updated;
  }

  /**
   * Who gets a reply that mentions nobody: the teammates whose requests it answers. An agent
   * that calls another gets the answer back without the other having to remember to @mention.
   * - The lead's unaddressed replies are for the human, so they go to nobody else.
   * - An answer that was itself returned this way asks for nothing, so nothing goes back.
   */
  private askersOf(author: Agent, answered: InboxItem[], team: Agent[]): Agent[] {
    if (author.role === 'lead') return [];
    const askers: Agent[] = [];
    for (const item of answered) {
      if (item.returned || item.trigger.authorKind !== 'agent') continue;
      const asker = team.find((member) => member.id === item.trigger.authorAgentId);
      if (asker && !askers.includes(asker)) askers.push(asker);
    }
    return askers;
  }

  /**
   * Asks for a project.md update once the group has been quiet for `delayMs`. Asking again
   * restarts the wait. If the scribe is already writing, it runs once more afterwards.
   */
  private scheduleScribe(groupId: string, delayMs: number): void {
    const work = this.workOf(groupId);
    if (work.scribe) {
      if (!work.scribe.waiting) {
        work.scribeAgain = true;
        return;
      }
      work.scribe.controller.abort();
    }

    const controller = new AbortController();
    const job: ScribeJob = { controller, waiting: true, done: Promise.resolve() };
    work.scribe = job;
    job.done = (async () => {
      try {
        await sleep(delayMs, undefined, { signal: controller.signal });
        const group = getGroup(this.ctx.db, groupId);
        if (!group) return;
        job.waiting = false;
        await this.hooks.onIdle(group, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && !(error instanceof CancelledError)) {
          postNotice(this.ctx, groupId, `The scribe failed: ${String(error)}`, 'error');
        }
      } finally {
        // A job that was cancelled or replaced has already been taken off the group.
        if (work.scribe === job) {
          work.scribe = undefined;
          if (work.scribeAgain) {
            work.scribeAgain = false;
            if (!this.hasTeamWork(work)) this.scheduleScribe(groupId, this.scribeDelayMs);
          }
        }
      }
    })();
  }

  /**
   * One agent turn. Returns what it left behind, or undefined if the turn failed. With
   * `turn.review` it is a review the engine asked for: the agent reads the worker's folder,
   * changes nothing, runs nothing, and its reply carries a verdict.
   */
  private async runTurn(
    group: Group,
    agent: Agent,
    turn: {
      triggers: Message[];
      threadId: number;
      round: number;
      interrupted: boolean;
      review?: ReviewJob;
    },
    signal: AbortSignal,
  ): Promise<TurnResult | undefined> {
    const { triggers, threadId, round } = turn;
    const { ctx } = this;
    ctx.hub.broadcast(group.id, { type: 'agent.activity', agentId: agent.id, activity: 'working' });
    const started = Date.now();
    let liveChanges: PacedTask | undefined;
    try {
      const workspace: Workspace = turn.review
        ? { cwd: turn.review.cwd }
        : await this.hooks.prepareWorkspace(group, agent);
      liveChanges = this.watchChanges(group, agent, workspace);
      const watching = liveChanges;
      const outsideEdits = new Set<string>();
      // A terminal needs a provider that asks before it runs a command, and an engine to ask.
      const canAsk = PROVIDERS.find((info) => info.id === agent.provider)?.canRunCommands;
      const decideCommand =
        canAsk && !turn.review ? this.hooks.decideCommand?.bind(this.hooks) : undefined;
      // The engine, not the model, decides what the agent may touch. A review only reads.
      const { files, effort } = agent.settings;
      const access = turn.review && files !== 'none' ? 'read' : files;
      const commands = turn.review ? 'off' : agent.settings.commands;
      const promptInput = {
        group,
        agent,
        team: listAgents(ctx.db, group.id),
        everyone: listAgents(ctx.db, group.id, { includeFired: true }),
        roleText: ctx.roles.of(agent).text,
        roles: ctx.roles.list(),
        access,
        terminal: decideCommand ? agent.settings : undefined,
        branch: workspace.branch,
        projectMd: projectForPrompt(await readProjectFile(group.folderPath)),
        memory: memoryForPrompt(await readMemory(ctx.dataDir, agent.id)),
        history: listMessages(ctx.db, group.id, { limit: Math.max(LEAD_HISTORY, 200) }),
        triggers,
        interrupted: turn.interrupted,
        review: turn.review && { worker: turn.review.worker, card: turn.review.card },
      };

      const result = await ctx.createAdapter(agent).run({
        agentName: agent.name,
        model: agent.model,
        systemPrompt: buildSystemPrompt(promptInput),
        prompt: buildPrompt(promptInput),
        trigger: triggers.map((trigger) => trigger.body).join('\n\n'),
        workingDirectory: workspace.cwd,
        access,
        effort,
        commands,
        // The engine, not the model and not the provider, decides every command.
        onCommand:
          decideCommand && commands !== 'off'
            ? (request) => decideCommand(group, agent, workspace, request, signal)
            : undefined,
        onEvent: (event) => {
          this.onAgentEvent(group, agent, event);
          this.warnAboutOutsideEdit(group, agent, event, outsideEdits);
          // Any tool call may have changed files: providers add tools this code has no name
          // for. Looking again is cheap, and it is paced.
          if (event.kind !== 'text') watching?.request();
        },
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
        threadId,
        round,
      });

      logEvent(ctx.db, {
        groupId: group.id,
        agentId: agent.id,
        kind: 'agent.turn',
        detail: {
          provider: agent.provider,
          model: agent.model,
          access,
          effort,
          triggerMessageIds: triggers.map((trigger) => trigger.id),
          threadId,
          round,
          replyMessageId: reply.id,
          durationMs: Date.now() - started,
          costUsd: result.costUsd,
          changedFiles: result.changedFiles,
          memoryNotes: parsed.memoryNotes.length,
          ...(turn.review
            ? { reviewOf: turn.review.card.id, verdict: parsed.verdict ?? 'unclear' }
            : {}),
        },
      });

      if (result.warning) postNotice(ctx, group.id, `${agent.name}: ${result.warning}`, 'warning');
      for (const problem of parsed.problems) postNotice(ctx, group.id, problem, 'warning');
      if (agent.role === 'lead') {
        this.postHireProposals(group, agent, parsed.hireProposals, parsed.roleDrafts);
      }

      let change: Message | undefined;
      // A review changes no files, so there is nothing to record.
      if (!turn.review) {
        try {
          change = await this.hooks.afterTurn(group, agent, workspace, reply, signal);
        } catch (error) {
          postNotice(
            ctx,
            group.id,
            `Could not record ${agent.name}'s work: ${String(error)}`,
            'error',
          );
        }
      }
      return { reply, workspace, change, verdict: parsed.verdict };
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) throw new CancelledError();
      const details = error instanceof AdapterError && error.details ? `\n\n${error.details}` : '';
      const reason = error instanceof Error ? error.message : String(error);
      postNotice(ctx, group.id, `${agent.name} could not finish: ${reason}${details}`, 'error');
      logEvent(ctx.db, {
        groupId: group.id,
        agentId: agent.id,
        kind: 'agent.turn_failed',
        detail: { reason, threadId, durationMs: Date.now() - started },
      });
      return undefined;
    } finally {
      // One last look, after the commit: the live view empties, or shows what a turn that was
      // stopped or failed left behind.
      await liveChanges?.finish();
      // An agent can be on a review and on a turn of its own at once. It is idle when both end.
      const work = this.groups.get(group.id);
      const stillWorking = turn.review
        ? work?.inboxes.get(agent.id)?.turn !== undefined
        : work?.reviewing.has(agent.id) === true;
      ctx.hub.broadcast(group.id, {
        type: 'agent.activity',
        agentId: agent.id,
        activity: stillWorking ? 'working' : 'idle',
      });
    }
  }

  /**
   * Shows the team what an agent is doing and records it. Every tool call goes into the audit
   * log; what the agent says along the way is only shown.
   */
  private onAgentEvent(group: Group, agent: Agent, event: AgentEvent): void {
    try {
      const at = Date.now();
      this.ctx.hub.broadcast(group.id, {
        type: 'agent.progress',
        progress: { agentId: agent.id, at, event },
      });
      if (event.kind === 'text') return;
      logEvent(
        this.ctx.db,
        { groupId: group.id, agentId: agent.id, kind: AGENT_TOOL_EVENT, detail: { ...event } },
        at,
      );
    } catch {
      // Reporting progress must never break the turn it reports on.
    }
  }

  /**
   * A provider's own sandbox may let an agent write somewhere outside its folder, such as the
   * CLI's scratch folder. Symposium cannot undo that, but it says so, once per file and turn.
   * Adapters show a path in full only when it lies outside the agent's folder.
   */
  private warnAboutOutsideEdit(
    group: Group,
    agent: Agent,
    event: AgentEvent,
    warned: Set<string>,
  ): void {
    const path = event.kind === 'edit' ? event.target : undefined;
    if (path === undefined || !isAbsolute(path) || warned.has(path)) return;
    warned.add(path);
    try {
      postNotice(
        this.ctx,
        group.id,
        `${agent.name} changed a file outside its folder: ${path}. Symposium does not track or commit it.`,
        'warning',
      );
    } catch {
      // Reporting must never break the turn.
    }
  }

  /** Pushes the agent's uncommitted diff to the UI when asked, at a steady pace. */
  private watchChanges(group: Group, agent: Agent, workspace: Workspace): PacedTask | undefined {
    const { liveChanges } = this.hooks;
    if (!liveChanges || !workspace.branch) return undefined;
    return new PacedTask(async () => {
      const changes = await liveChanges(group, agent, workspace);
      if (!changes) return;
      this.ctx.hub.broadcast(group.id, { type: 'worktree.changed', agentId: agent.id, changes });
    }, this.liveChangesIntervalMs);
  }

  /** Checks the roles a lead wrote. One that cannot be used is reported and left out. */
  private readRoleDrafts(group: Group, lead: Agent, texts: string[]): RoleDraft[] {
    const drafts: RoleDraft[] = [];
    for (const text of texts) {
      try {
        const draft = validateRoleDraft(parseRoleFile(text));
        // Who leads and who keeps project.md is the human's choice, made in the hire form.
        if (draft.kind !== 'worker' && draft.kind !== 'reviewer') {
          throw new Error('a role written by the lead works as a worker or as a reviewer');
        }
        drafts.push(draft);
      } catch (error) {
        postNotice(
          this.ctx,
          group.id,
          `${lead.name} wrote a role that can't be used: ${(error as Error).message}`,
          'warning',
        );
      }
    }
    return drafts;
  }

  /**
   * Turns the lead's ```hire blocks into proposals the human approves or declines. A hire may
   * use a role the lead wrote in the same reply: that role travels with the proposal and is
   * added only if the human approves the hire.
   */
  private postHireProposals(
    group: Group,
    lead: Agent,
    proposals: unknown[],
    roleTexts: string[],
  ): void {
    const { roles } = this.ctx;
    const drafts = this.readRoleDrafts(group, lead, roleTexts);
    const used = new Set<RoleDraft>();

    for (const proposal of proposals) {
      let hire: HireRequest;
      let newRole: RoleDraft | undefined;
      try {
        if (typeof proposal !== 'object' || proposal === null) {
          throw new Error('a hire is a JSON object');
        }
        const wanted = proposal as HireRequest;
        const roleWanted = String(wanted.roleId ?? wanted.role ?? '');
        if (!roles.find(roleWanted)) {
          newRole = drafts.find((draft) => roleIdFor(draft.title) === roleIdFor(roleWanted));
        }
        // A lead proposes who to hire. What the new agent may touch is for the human to set,
        // so any settings in the proposal are dropped and the role's defaults apply.
        hire = validateHire(
          newRole
            ? { ...wanted, role: newRole.kind, roleId: undefined, settings: undefined }
            : { ...wanted, settings: undefined },
          roles,
        );
        if (newRole) {
          used.add(newRole);
          hire.roleId = roleIdFor(newRole.title);
        }
      } catch (error) {
        postNotice(
          this.ctx,
          group.id,
          `${lead.name} proposed a hire that can't be used: ${(error as Error).message}`,
          'warning',
        );
        continue;
      }
      const role = newRole
        ? newRole.title
        : roleName(roles, { role: hire.role, roleId: hire.roleId! });
      const wrote = newRole ? ` ${lead.name} wrote the role "${newRole.title}" for this hire.` : '';
      postMessage(this.ctx, {
        groupId: group.id,
        authorKind: 'system',
        body: `${lead.name} proposes hiring ${hire.name} as ${role} (${hire.provider} · ${hire.model}).${wrote}`,
        meta: {
          type: 'hire-proposal',
          status: 'pending',
          proposedBy: lead.id,
          hire,
          ...(newRole ? { newRole } : {}),
        },
      });
    }

    for (const draft of drafts.filter((candidate) => !used.has(candidate))) {
      const why = roles.find(draft.title)
        ? 'a role with that name already exists'
        : 'no hire in the same message uses it';
      postNotice(
        this.ctx,
        group.id,
        `${lead.name} wrote the role "${draft.title}", but ${why}, so it was not added.`,
        'warning',
      );
    }
  }
}
