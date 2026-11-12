import type { Agent, AgentActivity, Group } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import type { Catalog } from '../App.tsx';
import { HireForm } from './HireForm.tsx';
import { MemoryDialog } from './MemoryDialog.tsx';

interface TeamPanelProps {
  group: Group;
  team: Agent[];
  activity: Record<string, AgentActivity>;
  /** Per agent, the ids of messages waiting in its inbox. */
  queues: Record<string, number[]>;
  catalog: Catalog;
}

/** "Working", "Idle", "Working · 2 queued" or "1 queued" (waiting for a free slot). */
export function agentStatusLabel(working: boolean, queued: number): string {
  const waiting = queued > 0 ? `${queued} queued` : '';
  if (working) return waiting ? `Working · ${waiting}` : 'Working';
  return waiting || 'Idle';
}

export function TeamPanel({ group, team, activity, queues, catalog }: TeamPanelProps) {
  const [hiring, setHiring] = useState(false);
  const [memoryOf, setMemoryOf] = useState<Agent>();
  const [error, setError] = useState<string>();

  async function fire(agent: Agent): Promise<void> {
    if (!confirm(`Fire ${agent.name}? Their branch, worktree and memory are kept.`)) return;
    try {
      await api.fire(group.id, agent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stop(agent: Agent): Promise<void> {
    try {
      await api.stopAgent(group.id, agent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (hiring) {
    return <HireForm group={group} team={team} catalog={catalog} onDone={() => setHiring(false)} />;
  }

  return (
    <div className="team-panel">
      {team.length === 0 && (
        <p className="muted small">
          Start with a <strong>lead</strong>: it plans the work, asks you to approve the plan and
          proposes the rest of the team. Add a <strong>scribe</strong> on a cheap model to keep
          project.md current.
        </p>
      )}
      <ul className="agent-list">
        {team.map((agent) => {
          const working = activity[agent.id] === 'working';
          const queued = queues[agent.id]?.length ?? 0;
          const busy = working || queued > 0;
          return (
            <li key={agent.id} className="agent-card">
              <div className="agent-card-top">
                <span className={`activity-dot${working ? ' activity-working' : ''}`} aria-hidden />
                <strong>{agent.name}</strong>
                <span className={`role-badge role-${agent.role}`}>{agent.role}</span>
                <span className={`agent-status${busy ? ' agent-status-busy' : ''}`}>
                  {agentStatusLabel(working, queued)}
                </span>
              </div>
              <div className="muted small">
                {agent.provider} · {agent.model}
              </div>
              {agent.instructions && (
                <div className="small agent-instructions">{agent.instructions}</div>
              )}
              <div className="agent-actions">
                {busy && (
                  <button
                    type="button"
                    className="link-button"
                    title={`Cancel ${agent.name}'s turn and empty their inbox. Everyone else carries on.`}
                    onClick={() => void stop(agent)}
                  >
                    Stop
                  </button>
                )}
                <button type="button" className="link-button" onClick={() => setMemoryOf(agent)}>
                  Memory
                </button>
                <button
                  type="button"
                  className="link-button danger"
                  onClick={() => void fire(agent)}
                >
                  Fire
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="form-error">{error}</p>}
      <button type="button" onClick={() => setHiring(true)}>
        + Hire an agent
      </button>
      {memoryOf && (
        <MemoryDialog group={group} agent={memoryOf} onClose={() => setMemoryOf(undefined)} />
      )}
    </div>
  );
}
