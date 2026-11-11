import type { Group } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import type { Catalog } from '../App.tsx';
import { activeAgents, workingAgents } from '../group-state.ts';
import { useGroup } from '../use-group.ts';
import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import { TeamPanel } from './TeamPanel.tsx';

const STATUS_LABELS = { connecting: 'Connecting…', open: 'Live', closed: 'Reconnecting…' };
const ROUND_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];

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

  async function setRounds(maxRounds: number): Promise<void> {
    try {
      onGroupChanged(await api.updateGroup(group.id, { maxRounds }));
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function stop(): Promise<void> {
    try {
      await api.stop(group.id);
    } catch (err) {
      setActionError(String(err));
    }
  }

  const hint =
    team.length === 0
      ? 'Hire a team first (Team panel on the right)'
      : `Message the team. @${team[0]!.name} to talk to someone directly. Enter to send.`;

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
            title="How many times work may pass between agents before the team waits for you"
          >
            Round limit{' '}
            <select
              value={group.maxRounds}
              onChange={(event) => void setRounds(Number(event.target.value))}
            >
              {ROUND_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
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
          <MessageList groupId={group.id} messages={state.messages} agents={state.agents} />
          {(state.running || working.length > 0) && (
            <div className="working-bar">
              <span className="working-dot" aria-hidden />
              <span>
                {working.length > 0
                  ? `${working.map((agent) => agent.name).join(', ')} ${working.length === 1 ? 'is' : 'are'} working…`
                  : 'The team is working…'}
              </span>
              {state.running && (
                <button
                  type="button"
                  className="button-secondary button-small"
                  onClick={() => void stop()}
                >
                  Stop
                </button>
              )}
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
            <TeamPanel group={group} team={team} activity={state.activity} catalog={catalog} />
          ) : (
            <ProjectPanel group={group} version={state.projectVersion} />
          )}
        </aside>
      </div>
    </div>
  );
}
