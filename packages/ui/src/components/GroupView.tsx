import type { Group, UpdateGroupRequest } from '@symposium/engine/protocol';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { api, type CodeLocation } from '../api.ts';
import type { Catalog } from '../App.tsx';
import { activeAgents, editingAgents, queuedFor, workingAgents } from '../group-state.ts';
import {
  clampSideWidth,
  loadSideWidth,
  MIN_CHAT_WIDTH,
  MIN_SIDE_WIDTH,
  saveSideWidth,
  type SideLayout,
} from '../side-width.ts';
import { shortPath } from '../text-format.ts';
import { useGroup } from '../use-group.ts';
import { Avatar } from './Avatar.tsx';
import { CodePanel, type CodeView } from './CodePanel.tsx';
import { Composer } from './Composer.tsx';
import { BranchIcon, CodeIcon, SlidersIcon, StopIcon } from './icons.tsx';
import { MessageList } from './MessageList.tsx';
import { ProjectPanel } from './ProjectPanel.tsx';
import { TeamPanel } from './TeamPanel.tsx';

const STATUS_LABELS = { connecting: 'Connecting…', open: 'Live', closed: 'Reconnecting…' };
const ROUND_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];
const PARALLEL_CHOICES = [1, 2, 3, 4, 5, 6, 8];

/** The group's settings, tucked behind one button so the title bar stays calm. */
function GroupSettings({
  group,
  onChange,
  onDelete,
}: {
  group: Group;
  onChange: (changes: UpdateGroupRequest) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(group.name);

  const [check, setCheck] = useState(group.checkCommand);

  function saveCheck(): void {
    const wanted = check.trim();
    setCheck(wanted);
    if (wanted !== group.checkCommand) onChange({ checkCommand: wanted });
  }

  function rename(): void {
    const wanted = name.trim();
    if (wanted && wanted !== group.name) onChange({ name: wanted });
    else setName(group.name);
  }

  const ref = useRef<HTMLDivElement>(null);

  // Clicking anywhere else, or pressing Escape, closes it.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="popover-anchor" ref={ref}>
      <button
        type="button"
        className="button-secondary button-small"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <SlidersIcon /> Settings
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Group settings">
          <label className="setting-row setting-row-stacked">
            <span>Name</span>
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              onBlur={rename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </label>
          <label className="setting-row">
            <span>
              Round limit
              <small>
                How many times work may pass between agents in one thread before it waits for you
              </small>
            </span>
            <select
              value={group.maxRounds}
              onChange={(event) => onChange({ maxRounds: Number(event.target.value) })}
            >
              {ROUND_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-row">
            <span>
              Agents at once
              <small>How many agents may work at the same time</small>
            </span>
            <select
              value={group.maxParallel}
              onChange={(event) => onChange({ maxParallel: Number(event.target.value) })}
            >
              {PARALLEL_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-row">
            <span>
              Approve the lead's plan first
              <small>
                On: Symposium holds the lead's assignments until you approve the plan. Off: the lead
                starts assigning tasks right away.
              </small>
            </span>
            <input
              type="checkbox"
              className="switch"
              role="switch"
              checked={group.leadAsksFirst}
              onChange={(event) => onChange({ leadAsksFirst: event.target.checked })}
            />
          </label>
          <label className="setting-row setting-row-stacked">
            <span>
              Check command
              <small>
                Symposium runs it in a worker's folder after each of its changes and shows the
                result on the diff, for example <code>npm test</code>. It runs the worker's code
                without asking you each time. Empty: no check.
              </small>
            </span>
            <input
              value={check}
              maxLength={1000}
              placeholder="npm test"
              spellCheck={false}
              onChange={(event) => setCheck(event.target.value)}
              onBlur={saveCheck}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </label>
          <div className="setting-row setting-row-danger">
            <span>
              Delete this group
              <small>
                Removes the chat, the team, their memory and their worktrees. Your project folder
                and its git branches stay.
              </small>
            </span>
            <button type="button" className="button-danger button-small" onClick={onDelete}>
              Delete…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface GroupViewProps {
  group: Group;
  catalog: Catalog;
  onGroupChanged: (group: Group) => void;
  onGroupDeleted: (groupId: string) => void;
}

export function GroupView({ group, catalog, onGroupChanged, onGroupDeleted }: GroupViewProps) {
  const { state, status, loadError, send, runCommand } = useGroup(
    group.id,
    onGroupChanged,
    onGroupDeleted,
  );
  const [panel, setPanel] = useState<'team' | 'project' | 'code'>('team');
  const [code, setCode] = useState<{ where: CodeLocation; view: CodeView }>({
    where: 'project',
    view: 'files',
  });
  const [actionError, setActionError] = useState<string>();
  // The side panel's width, when the human has dragged it. The Code tab keeps its own.
  const [sideWidths, setSideWidths] = useState<Record<SideLayout, number | undefined>>(() => ({
    narrow: loadSideWidth('narrow'),
    wide: loadSideWidth('wide'),
  }));
  const bodyRef = useRef<HTMLDivElement>(null);
  const layout: SideLayout = panel === 'code' ? 'wide' : 'narrow';
  const sideWidth = sideWidths[layout];
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

  async function openInEditor(target?: { where: CodeLocation; path?: string }): Promise<void> {
    try {
      await api.openInEditor(group.id, target);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteGroup(): Promise<void> {
    const unmerged = state.messages.filter(
      (message) => message.meta?.type === 'diff' && message.meta.status === 'pending',
    ).length;
    const warning =
      unmerged > 0
        ? `\n\n${unmerged} diff${unmerged === 1 ? ' is' : 's are'} not merged yet. That work stays on its symposium/… branch in your project, but it will no longer be shown here.`
        : '';
    if (
      !confirm(
        `Delete "${group.name}"? Its chat, team, agent memory and worktrees are removed for good. Your project folder and its git branches are kept.${warning}`,
      )
    ) {
      return;
    }
    try {
      await api.deleteGroup(group.id);
      onGroupDeleted(group.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function stopAll(): Promise<void> {
    try {
      await api.stopAll(group.id);
    } catch (err) {
      setActionError(String(err));
    }
  }

  function resizeSide(wanted: number | undefined, remember: boolean): void {
    const body = bodyRef.current;
    if (!body) return;
    const width = wanted === undefined ? undefined : clampSideWidth(wanted, body.clientWidth);
    setSideWidths((current) => ({ ...current, [layout]: width }));
    if (remember) saveSideWidth(layout, width);
  }

  function dragSide(event: ReactPointerEvent<HTMLDivElement>): void {
    const body = bodyRef.current;
    // While a button is held on the handle, the panel's left edge follows the pointer.
    if (!body || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    resizeSide(body.getBoundingClientRect().right - event.clientX, event.type === 'pointerup');
  }

  function nudgeSide(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = sideWidth ?? event.currentTarget.parentElement!.clientWidth;
    resizeSide(current + (event.key === 'ArrowLeft' ? 24 : -24), true);
  }

  const placeholder =
    team.length === 0 ? 'Hire a team first, in the Team panel on the right' : 'Message the team…';
  const hint = team.length > 0 && (
    <>
      <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> adds a line. Nobody stops when you
      write. <code>@{team[0]!.name}</code> talks to one agent, <code>/stop</code> stops work,{' '}
      <code>/now @name</code> interrupts.
    </>
  );

  return (
    <div className="group-view">
      <header className="group-header">
        <div className="group-title">
          <Avatar name={group.name} variant="square" />
          <div className="group-title-text">
            <h1>{group.name}</h1>
            {group.folderPath && (
              <div className="muted small group-location">
                <span title={group.folderPath}>{shortPath(group.folderPath)}</span>
                {group.baseBranch && (
                  <span className="branch-chip">
                    <BranchIcon /> {group.baseBranch}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="group-header-controls">
          <span className={`status status-${status}`}>
            <span className="status-dot" aria-hidden />
            {STATUS_LABELS[status]}
          </span>
          <GroupSettings
            group={group}
            onChange={(changes) => void changeGroup(changes)}
            onDelete={() => void deleteGroup()}
          />
          <button
            type="button"
            className="button-secondary button-small"
            title="Opens the project and every agent's worktree side by side in one VS Code window"
            onClick={() => void openInEditor()}
          >
            <CodeIcon /> Open in VS Code
          </button>
        </div>
      </header>

      <div
        ref={bodyRef}
        className={panel === 'code' ? 'group-body group-body-wide' : 'group-body'}
        style={
          sideWidth === undefined
            ? undefined
            : // A narrower window than the one it was dragged in still leaves room for the chat.
              ({
                '--side-width': `max(${MIN_SIDE_WIDTH}px, min(${sideWidth}px, calc(100% - ${MIN_CHAT_WIDTH}px)))`,
              } as CSSProperties)
        }
      >
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
            roles={catalog.roles}
            queuedFor={queuedFor(state)}
          />
          {busy && (
            <div className="working-bar">
              <span className="typing-dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
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
                <StopIcon /> Stop all
              </button>
            </div>
          )}
          <Composer onSend={send} placeholder={placeholder} hint={hint} />
        </section>

        <aside className="side-panel">
          <div
            className="resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side panel"
            title="Drag to resize. Double-click to reset."
            tabIndex={0}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={dragSide}
            onPointerUp={dragSide}
            onDoubleClick={() => resizeSide(undefined, true)}
            onKeyDown={nudgeSide}
          />
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'team'}
              className={panel === 'team' ? 'tab tab-active' : 'tab'}
              onClick={() => setPanel('team')}
            >
              Team <span className="tab-count">{team.length}</span>
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
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'code'}
              className={panel === 'code' ? 'tab tab-active' : 'tab'}
              onClick={() => setPanel('code')}
            >
              Code
            </button>
          </div>
          {panel === 'team' && (
            <TeamPanel
              group={group}
              team={team}
              activity={state.activity}
              queues={state.queues}
              progress={state.progress}
              liveChanges={state.liveChanges}
              onOpenInEditor={(agent) => void openInEditor({ where: agent.id })}
              onShowChanges={(agent) => {
                setCode({ where: agent.id, view: 'changes' });
                setPanel('code');
              }}
              catalog={catalog}
            />
          )}
          {panel === 'project' && <ProjectPanel group={group} version={state.projectVersion} />}
          {panel === 'code' && (
            <CodePanel
              group={group}
              editors={editingAgents(state)}
              liveChanges={state.liveChanges}
              filesVersion={state.filesVersion}
              terminal={state.terminal}
              onRun={runCommand}
              onPost={send}
              onOpenInEditor={(where, path) => void openInEditor({ where, path })}
              where={code.where}
              view={code.view}
              onChoose={(where, view) => setCode({ where, view })}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
