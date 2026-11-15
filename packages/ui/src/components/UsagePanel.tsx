import type { Agent, Group, GroupUsage, UsageTotals } from '@symposium/engine/protocol';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { formatCost, formatTurns, formatWorkTime } from '../usage-format.ts';

function Row({ label, usage, title }: { label: string; usage: UsageTotals; title?: string }) {
  return (
    <tr>
      <th scope="row" title={title}>
        {label}
      </th>
      <td>{formatTurns(usage)}</td>
      <td>{formatWorkTime(usage.durationMs)}</td>
      <td>{formatCost(usage)}</td>
    </tr>
  );
}

const HEAD = (
  <thead>
    <tr>
      <th />
      <th scope="col">Turns</th>
      <th scope="col">Time</th>
      <th scope="col">Cost</th>
    </tr>
  </thead>
);

/**
 * What the group's work has taken: per agent, and per task. A task is one message of the human
 * and everything the team did because of it. Reloads when `version` changes.
 */
export function UsagePanel({
  group,
  agents,
  version,
}: {
  group: Group;
  /** Everyone who ever worked in the group, to name those who have left. */
  agents: Agent[];
  version: number;
}) {
  const [usage, setUsage] = useState<GroupUsage>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    api
      .usage(group.id)
      .then((result) => {
        if (!active) return;
        setUsage(result);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [group.id, version]);

  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? 'Former agent';

  return (
    <div className="usage-panel">
      {error && <p className="form-error">{error}</p>}
      {!usage ? (
        !error && <p className="muted small">Loading…</p>
      ) : usage.total.turns === 0 ? (
        <p className="muted small">Nobody has worked yet.</p>
      ) : (
        <>
          <table className="usage-table">
            {HEAD}
            <tbody>
              {usage.agents.map((agent) => (
                <Row key={agent.agentId} label={nameOf(agent.agentId)} usage={agent} />
              ))}
            </tbody>
            <tfoot>
              <Row label="Everyone" usage={usage.total} />
            </tfoot>
          </table>
          <h3 className="usage-heading">By task</h3>
          <table className="usage-table">
            {HEAD}
            <tbody>
              {usage.threads.map((thread) => (
                <Row
                  key={thread.threadId}
                  label={thread.title || `Message #${thread.threadId}`}
                  title={`${thread.title}\n${thread.agentIds.map(nameOf).join(', ')}`}
                  usage={thread}
                />
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted small">
        A task is one of your messages and everything the team did because of it. Cost is what the
        provider reports for a turn. Claude Code reports the price at API rates, also when you pay
        by subscription. Antigravity and API providers report none: their turns show time only, and
        a + marks a sum that leaves such turns out.
      </p>
    </div>
  );
}
