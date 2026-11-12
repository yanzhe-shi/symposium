import type { Group, UpdateGroupRequest } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import type { Catalog } from '../App.tsx';
import { activeAgents, queuedFor, workingAgents } from '../group-state.ts';
import { useGroup } from '../use-group.ts';
import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import { TeamPanel } from './TeamPanel.tsx';

const STATUS_LABELS = { connecting: 'Connecting…', open: 'Live', closed: 'Reconnecting…' };
const ROUND_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];
const PARALLEL_CHOICES = [1, 2, 3, 4, 5, 6, 8];

interface GroupViewProps {
  group: Group;
  catalog: Catalog;
  onGroupChanged: (group: Group) => void;
}

export function GroupView({ group, catalog, onGroupChanged }: GroupViewProps) {
  const { state, status, loadError, send } = useGroup(group.id, onGroupChanged);
  const [panel, setPanel] = useState<'team' | 'project'>('team');
  const [actionError, setActionError] = useState<string>();
  const team = activeAgents(state);
  const working = workingAgents(state);

  const queued = team.reduce((sum, agent) => sum + (state.queues[agent.id]?.length ?? 0), 0);
  const busy = state.running || working.length > 0;

  async function changeGroup(changes: UpdateGroupRequest): Promise<void> {
    try {
      onGroupChanged(await api.updateGroup(group.id, changes));
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function stopAll(): Promise<void> {
    try {
      await api.stopAll(group.id);
    } catch (err) {
      setActionError(String(err));
    }
  }

  const hint =
    team.length === 0
      ? 'Hire a team first (Team panel on the right)'
      : `Message the team at any time; nobody stops. @${team[0]!.name} talks to someone directly, /stop stops work, /now @name interrupts.`;

  return (
    <div className="group-view">
      <header className="group-header">
        <div>
          <h1># {group.name}</h1>
          {group.folderPath && (
            <div className="muted small">
              {group.folderPath}
              {group.baseBranch && ` · ${group.baseBranch}`}
            </div>
          )}
        </div>
        <div className="group-header-controls">
          <label
            className="small"
            title="How many times work may pass between agents in one thread before it waits for you"
          >
            Round limit{' '}
            <select
              value={group.maxRounds}
              onChange={(event) => void changeGroup({ maxRounds: Number(event.target.value) })}
            >
              {ROUND_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="small" title="How many agents may work at the same time">
            At once{' '}
            <select
              value={group.maxParallel}
              onChange={(event) => void changeGroup({ maxParallel: Number(event.target.value) })}
            >
              {PARALLEL_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label
            className="small"
            title="On: the lead proposes a plan and waits for your approval. Off: the lead starts assigning tasks right away."
          >
            <input
              type="checkbox"
              checked={group.leadAsksFirst}
              onChange={(event) => void changeGroup({ leadAsksFirst: event.target.checked })}
            />{' '}
            Lead asks before starting work
          </label>
          <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>
        </div>
      </header>

      <div className="group-body">
        <section className="chat-column">
          {loadError && <p className="banner-error">Could not load the group: {loadError}</p>}
          {actionError && (
            <p className="banner-error">
              {actionError}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => setActionError(undefined)}
              >
                Dismiss
              </button>
            </p>
          )}
          <MessageList
            groupId={group.id}
            messages={state.messages}
            agents={state.agents}
            queuedFor={queuedFor(state)}
          />
          {busy && (
            <div className="working-bar">
              <span className="working-dot" aria-hidden />
              <span>
                {working.length > 0
                  ? `${working.map((agent) => agent.name).join(', ')} ${working.length === 1 ? 'is' : 'are'} working…`
                  : 'The team is working…'}
                {queued > 0 && ` ${queued} message${queued === 1 ? '' : 's'} queued.`}
                {' You can keep typing.'}
              </span>
              <button
                type="button"
                className="button-secondary button-small"
                title="Cancel every turn and empty every inbox"
                onClick={() => void stopAll()}
              >
                Stop all
              </button>
            </div>
          )}
          <Composer onSend={send} placeholder={hint} />
        </section>

        <aside className="side-panel">
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'team'}
              className={panel === 'team' ? 'tab tab-active' : 'tab'}
              onClick={() => setPanel('team')}
            >
              Team ({team.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'project'}
              className={panel === 'project' ? 'tab tab-active' : 'tab'}
              onClick={() => setPanel('project')}
            >
              project.md
            </button>
          </div>
          {panel === 'team' ? (
            <TeamPanel
              group={group}
              team={team}
              activity={state.activity}
              queues={state.queues}
              catalog={catalog}
            />
          ) : (
            <ProjectPanel group={group} version={state.projectVersion} />
          )}
        </aside>
      </div>
    </div>
  );
}
