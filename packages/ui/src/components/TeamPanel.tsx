import type {
  Agent,
  AgentActivity,
  AgentProgress,
  Group,
  WorktreeChanges,
} from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import type { Catalog } from '../App.tsx';
import { activityLine } from '../group-state.ts';
import { AgentForm } from './AgentForm.tsx';
import { MemoryDialog } from './MemoryDialog.tsx';

interface TeamPanelProps {
  group: Group;
  team: Agent[];
  activity: Record<string, AgentActivity>;
  /** Per agent, the ids of messages waiting in its inbox. */
  queues: Record<string, number[]>;
  /** Per agent, what it did lately, oldest first. */
  progress: Record<string, AgentProgress[]>;
  /** Per agent, the uncommitted work in its worktree. */
  liveChanges: Record<string, WorktreeChanges>;
  /** Opens the Code tab on an agent's uncommitted changes. */
  onShowChanges: (agent: Agent) => void;
  catalog: Catalog;
}

const TIMELINE_LENGTH = 40;
const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** What an agent did lately, newest first: tool calls, refusals and things it said mid-turn. */
function ActivityTimeline({ progress }: { progress: AgentProgress[] }) {
  return (
    <ol className="timeline small" aria-label="Activity">
      {progress
        .slice(-TIMELINE_LENGTH)
        .reverse()
        .map((entry, index) => (
          <li
            key={`${entry.at}-${index}`}
            className={`timeline-entry timeline-${entry.event.kind}`}
          >
            <time className="muted" dateTime={new Date(entry.at).toISOString()}>
              {clockFormat.format(entry.at)}
            </time>
            <span title={entry.event.target}>{entry.event.summary}</span>
          </li>
        ))}
    </ol>
  );
}

/** "Working", "Idle", "Working · 2 queued" or "1 queued" (waiting for a free slot). */
export function agentStatusLabel(working: boolean, queued: number): string {
  const waiting = queued > 0 ? `${queued} queued` : '';
  if (working) return waiting ? `Working · ${waiting}` : 'Working';
  return waiting || 'Idle';
}

/** The settings worth showing on a card: only what differs from the role's usual setup. */
export function settingsSummary(agent: Agent, roleFiles: string | undefined): string[] {
  const parts: string[] = [];
  if (agent.settings.files !== roleFiles) parts.push(`files: ${agent.settings.files}`);
  if (agent.settings.effort !== 'default') parts.push(`effort: ${agent.settings.effort}`);
  return parts;
}

export function TeamPanel({
  group,
  team,
  activity,
  queues,
  progress,
  liveChanges,
  onShowChanges,
  catalog,
}: TeamPanelProps) {
  const [timelineOf, setTimelineOf] = useState<string>();
  const [hiring, setHiring] = useState(false);
  const [editing, setEditing] = useState<Agent>();
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

  if (hiring || editing) {
    return (
      <AgentForm
        key={editing?.id ?? 'hire'}
        group={group}
        team={team}
        catalog={catalog}
        agent={editing}
        onDone={() => {
          setHiring(false);
          setEditing(undefined);
        }}
      />
    );
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
          const did = progress[agent.id] ?? [];
          const lately = activityLine(did);
          const changed = liveChanges[agent.id]?.files.length ?? 0;
          const showTimeline = timelineOf === agent.id && did.length > 0;
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
                {[
                  agent.provider,
                  agent.model,
                  ...settingsSummary(
                    agent,
                    catalog.roles.find((role) => role.kind === agent.role)?.defaultFiles,
                  ),
                ].join(' · ')}
              </div>
              {agent.instructions && (
                <div className="small agent-instructions">{agent.instructions}</div>
              )}
              {lately && !showTimeline && (
                <div className="small agent-activity" title={lately}>
                  {lately}
                </div>
              )}
              {showTimeline && <ActivityTimeline progress={did} />}
              {changed > 0 && (
                <button
                  type="button"
                  className="link-button small"
                  title={`See what ${agent.name} has changed so far in this turn`}
                  onClick={() => onShowChanges(agent)}
                >
                  {changed} file{changed === 1 ? '' : 's'} changed, not committed yet
                </button>
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
                {did.length > 0 && (
                  <button
                    type="button"
                    className="link-button"
                    aria-expanded={showTimeline}
                    onClick={() => setTimelineOf(showTimeline ? undefined : agent.id)}
                  >
                    {showTimeline ? 'Hide activity' : 'Activity'}
                  </button>
                )}
                <button type="button" className="link-button" onClick={() => setEditing(agent)}>
                  Edit
                </button>
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
