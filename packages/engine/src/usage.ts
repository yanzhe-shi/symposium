import type { Db } from './db/database.js';
import type { GroupUsage, UsageTotals } from './protocol.js';
import { listEvents } from './store/events.js';
import { getMessage } from './store/messages.js';

const MAX_TITLE = 80;

function empty(): UsageTotals {
  return { turns: 0, failedTurns: 0, durationMs: 0, costUsd: null, pricedTurns: 0 };
}

function add(
  totals: UsageTotals,
  turn: { failed: boolean; durationMs: number; costUsd?: number },
): void {
  totals.turns += 1;
  if (turn.failed) totals.failedTurns += 1;
  totals.durationMs += turn.durationMs;
  if (turn.costUsd !== undefined) {
    totals.costUsd = (totals.costUsd ?? 0) + turn.costUsd;
    totals.pricedTurns += 1;
  }
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/**
 * What a group's work has taken so far, per agent and per task. Read from the audit log, so it
 * covers every turn since the group was made, also those of agents who have left.
 *
 * A task is a thread: one message of the human and everything the team did because of it.
 * Cost is only what a provider reported for a turn. Turns without one count as time.
 */
export function groupUsage(db: Db, groupId: string): GroupUsage {
  const total = empty();
  const agents = new Map<string, UsageTotals>();
  const threads = new Map<number, UsageTotals & { agentIds: Set<string> }>();

  for (const event of listEvents(db, groupId)) {
    const failed = event.kind === 'agent.turn_failed';
    // `project.updated` is a turn of the scribe, which runs outside the threads.
    if (event.kind !== 'agent.turn' && event.kind !== 'project.updated' && !failed) continue;
    if (event.agentId === null) continue;
    const { detail } = event;
    const turn = {
      failed,
      durationMs: numberOr(detail.durationMs, 0),
      costUsd: typeof detail.costUsd === 'number' ? detail.costUsd : undefined,
    };

    add(total, turn);
    let agent = agents.get(event.agentId);
    if (!agent) agents.set(event.agentId, (agent = empty()));
    add(agent, turn);

    if (typeof detail.threadId === 'number') {
      let thread = threads.get(detail.threadId);
      if (!thread) threads.set(detail.threadId, (thread = { ...empty(), agentIds: new Set() }));
      add(thread, turn);
      thread.agentIds.add(event.agentId);
    }
  }

  return {
    total,
    agents: [...agents].map(([agentId, totals]) => ({ agentId, ...totals })),
    // Newest task first.
    threads: [...threads]
      .sort(([a], [b]) => b - a)
      .map(([threadId, { agentIds, ...totals }]) => {
        const firstLine = (getMessage(db, threadId)?.body ?? '').trim().split('\n')[0] ?? '';
        const title =
          firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE - 1)}…` : firstLine;
        return { threadId, title, agentIds: [...agentIds], ...totals };
      }),
  };
}
