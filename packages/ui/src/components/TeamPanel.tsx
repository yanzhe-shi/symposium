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
  catalog: Catalog;
}

export function TeamPanel({ group, team, activity, catalog }: TeamPanelProps) {
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
        {team.map((agent) => (
          <li key={agent.id} className="agent-card">
            <div className="agent-card-top">
              <span
                className={`activity-dot${activity[agent.id] === 'working' ? ' activity-working' : ''}`}
                title={activity[agent.id] === 'working' ? 'Working' : 'Idle'}
              />
              <strong>{agent.name}</strong>
              <span className={`role-badge role-${agent.role}`}>{agent.role}</span>
            </div>
            <div className="muted small">
              {agent.provider} · {agent.model}
            </div>
            {agent.instructions && (
              <div className="small agent-instructions">{agent.instructions}</div>
            )}
            <div className="agent-actions">
              <button type="button" className="link-button" onClick={() => setMemoryOf(agent)}>
                Memory
              </button>
              <button type="button" className="link-button danger" onClick={() => void fire(agent)}>
                Fire
              </button>
            </div>
          </li>
        ))}
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
