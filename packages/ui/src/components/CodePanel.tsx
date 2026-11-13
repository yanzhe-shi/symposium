import type {
  Agent,
  FileContent,
  FolderListing,
  Group,
  WorktreeChanges,
} from '@symposium/engine/protocol';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type CodeLocation } from '../api.ts';
import { terminalReport, type TerminalState } from '../group-state.ts';
import { formatSize } from '../text-format.ts';
import { DiffView } from './DiffView.tsx';

export type CodeView = 'files' | 'changes' | 'terminal';

interface CodePanelProps {
  group: Group;
  /** Agents with a worktree of their own. */
  editors: Agent[];
  liveChanges: Record<string, WorktreeChanges>;
  /** Changes whenever files may have changed on disk. */
  filesVersion: number;
  /** The newest command the human ran from here. */
  terminal: TerminalState | undefined;
  onRun: (where: CodeLocation, command: string) => Promise<void>;
  /** Posts a message to the chat as the human. */
  onPost: (body: string) => Promise<void>;
  /** Opens a file of the shown folder in VS Code. */
  onOpenInEditor: (where: CodeLocation, path: string) => void;
  where: CodeLocation;
  view: CodeView;
  onChoose: (where: CodeLocation, view: CodeView) => void;
}

/**
 * The code: the project folder, or any agent's worktree with the changes it has made but not
 * yet committed. Files are read-only. The Terminal runs a command of your own there.
 */
export function CodePanel({
  group,
  editors,
  liveChanges,
  filesVersion,
  terminal,
  onRun,
  onPost,
  onOpenInEditor,
  where,
  view,
  onChoose,
}: CodePanelProps) {
  const [refreshes, setRefreshes] = useState(0);
  const agent = editors.find((editor) => editor.id === where);
  // Someone who was fired, or lost edit access, has no worktree to show any more.
  const location: CodeLocation = agent ? agent.id : 'project';
  const changes = agent ? liveChanges[agent.id] : undefined;
  const changed = changes?.files.length ?? 0;
  const shownView: CodeView = agent || view !== 'changes' ? view : 'files';
  const segments: [CodeView, string][] = [
    ['files', 'Files'],
    ...(agent
      ? [['changes', `Live changes${changed > 0 ? ` (${changed})` : ''}`] as [CodeView, string]]
      : []),
    ['terminal', 'Terminal'],
  ];

  return (
    <div className="code-panel">
      <div className="code-toolbar">
        <select
          aria-label="Folder to show"
          value={location}
          onChange={(event) => onChoose(event.target.value, 'files')}
        >
          <option value="project">
            Project folder{group.baseBranch ? ` (${group.baseBranch})` : ''}
          </option>
          {editors.map((editor) => (
            <option key={editor.id} value={editor.id}>
              {editor.name}'s worktree (symposium/{editor.name.toLowerCase()})
            </option>
          ))}
        </select>
        <div className="segmented" role="tablist">
          {segments.map(([segment, label]) => (
            <button
              key={segment}
              type="button"
              role="tab"
              aria-selected={shownView === segment}
              className={shownView === segment ? 'segment segment-active' : 'segment'}
              onClick={() => onChoose(location, segment)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button-secondary button-small"
          title="Read the files again"
          onClick={() => setRefreshes(refreshes + 1)}
        >
          Refresh
        </button>
      </div>

      {shownView === 'terminal' ? (
        <Terminal
          folder={agent ? `${agent.name}'s worktree` : 'the project folder'}
          groupId={group.id}
          terminal={terminal}
          onRun={(command) => onRun(location, command)}
          onPost={onPost}
        />
      ) : agent && shownView === 'changes' ? (
        <LiveChanges agent={agent} changes={changes} />
      ) : (
        <FileBrowser
          key={location}
          groupId={group.id}
          where={location}
          emptyHint={
            agent
              ? `${agent.name} has no worktree yet. It is created on their first turn.`
              : undefined
          }
          refreshKey={`${filesVersion}:${refreshes}`}
          onOpenInEditor={(path) => onOpenInEditor(location, path)}
        />
      )}
    </div>
  );
}

interface TerminalProps {
  /** Where a new command would run, in words. */
  folder: string;
  groupId: string;
  terminal: TerminalState | undefined;
  onRun: (command: string) => Promise<void>;
  onPost: (body: string) => Promise<void>;
}

function exitLabel(run: TerminalState): string {
  if (run.running) return 'Running…';
  if (run.exitCode === null) return 'Stopped';
  return run.exitCode === 0 ? 'Finished' : `Failed (exit code ${run.exitCode})`;
}

/**
 * Your own terminal: one command at a time, run in the chosen folder as you would run it
 * yourself. Agents see nothing of it unless you post the result to the chat.
 */
function Terminal({ folder, groupId, terminal, onRun, onPost }: TerminalProps) {
  const [command, setCommand] = useState('');
  const [error, setError] = useState<string>();
  const [posted, setPosted] = useState<string>();

  async function attempt(action: () => Promise<unknown>): Promise<void> {
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function run(event: FormEvent): void {
    event.preventDefault();
    if (command.trim() === '') return;
    void attempt(() => onRun(command));
  }

  return (
    <div className="terminal">
      <form className="terminal-form" onSubmit={run}>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="pnpm test"
          aria-label={`Command to run in ${folder}`}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" disabled={command.trim() === '' || terminal?.running}>
          Run
        </button>
      </form>
      <p className="muted small">
        Runs in {folder}, as it would in your own terminal: nothing is asked or checked. Agents do
        not see the output unless you post it to the chat.
      </p>
      {error && <p className="form-error small">{error}</p>}
      {terminal && (
        <>
          <header className="terminal-header small">
            <code>$ {terminal.command}</code>
            <span className="muted">
              {exitLabel(terminal)}
              {terminal.folder && ` · ${terminal.folder}`}
            </span>
          </header>
          <pre className="terminal-output">
            {terminal.output || (terminal.running ? '' : '(no output)')}
          </pre>
          <div className="form-actions">
            {terminal.running ? (
              <button
                type="button"
                className="button-danger"
                onClick={() => void attempt(() => api.stopCommand(groupId, terminal.runId))}
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="button-secondary"
                disabled={posted === terminal.runId}
                title="Posts the command and the end of its output as a message from you"
                onClick={() =>
                  void attempt(async () => {
                    await onPost(terminalReport(terminal));
                    setPosted(terminal.runId);
                  })
                }
              >
                {posted === terminal.runId ? 'Posted to chat' : 'Post to chat'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LiveChanges({ agent, changes }: { agent: Agent; changes: WorktreeChanges | undefined }) {
  if (!changes || changes.files.length === 0) {
    return (
      <p className="muted small">
        {agent.name} has no uncommitted changes. Edits show up here while {agent.name} works. When
        the turn ends they are committed on {agent.name}'s branch and posted in the chat as a diff
        for you to merge or discard.
      </p>
    );
  }
  return (
    <div className="live-changes">
      <p className="small">
        <strong>
          {changes.files.length} file{changes.files.length === 1 ? '' : 's'} changed
        </strong>{' '}
        in {agent.name}'s worktree, not committed yet:
      </p>
      <ul className="changed-files small">
        {changes.files.map((file) => (
          <li key={file}>
            <code>{file}</code>
          </li>
        ))}
      </ul>
      <DiffView diff={changes.diff} truncated={changes.truncated} />
    </div>
  );
}

interface FileBrowserProps {
  groupId: string;
  where: CodeLocation;
  /** Shown instead of an error when the folder does not exist yet. */
  emptyHint: string | undefined;
  refreshKey: string;
  onOpenInEditor: (path: string) => void;
}

/** A folder tree that loads each folder when it is opened, and a viewer for one file. */
function FileBrowser({ groupId, where, emptyHint, refreshKey, onOpenInEditor }: FileBrowserProps) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [listings, setListings] = useState<Record<string, FolderListing>>({});
  const [rootError, setRootError] = useState<string>();
  const [openPath, setOpenPath] = useState<string>();
  const [file, setFile] = useState<FileContent>();
  const [fileError, setFileError] = useState<string>();

  // Reads every open folder again whenever one is opened or the files may have changed.
  const openFolders = ['', ...expanded].join('\n');
  useEffect(() => {
    let active = true;
    for (const path of openFolders.split('\n')) {
      api
        .files(groupId, where, path)
        .then((listing) => {
          if (!active) return;
          setListings((current) => ({ ...current, [path]: listing }));
          if (path === '') setRootError(undefined);
        })
        .catch((err: unknown) => {
          if (!active) return;
          // A folder that has gone is closed. Losing the top folder is worth saying.
          setListings((current) => {
            const rest = { ...current };
            delete rest[path];
            return rest;
          });
          if (path === '') setRootError(err instanceof Error ? err.message : String(err));
          else setExpanded((current) => current.filter((open) => open !== path));
        });
    }
    return () => {
      active = false;
    };
  }, [groupId, where, openFolders, refreshKey]);

  useEffect(() => {
    if (openPath === undefined) return;
    let active = true;
    api
      .file(groupId, where, openPath)
      .then((loaded) => {
        if (!active) return;
        setFile(loaded);
        setFileError(undefined);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setFile(undefined);
        setFileError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [groupId, where, openPath, refreshKey]);

  function toggle(path: string): void {
    setExpanded((current) =>
      current.includes(path) ? current.filter((open) => open !== path) : [...current, path],
    );
  }

  function renderFolder(path: string, depth: number): ReactNode {
    const listing = listings[path];
    if (!listing) return null;
    return (
      <ul className="file-tree" role={depth === 0 ? 'tree' : 'group'}>
        {listing.entries.map((entry) => {
          const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
          const isOpen = entry.type === 'dir' && expanded.includes(entryPath);
          return (
            <li key={entry.name} role="treeitem" aria-expanded={entry.type === 'dir' && isOpen}>
              <button
                type="button"
                className={`tree-item${entryPath === openPath ? ' tree-item-open' : ''}`}
                style={{ paddingLeft: `${0.4 + depth * 0.9}rem` }}
                title={entry.type === 'file' ? formatSize(entry.size) : undefined}
                onClick={() => (entry.type === 'dir' ? toggle(entryPath) : setOpenPath(entryPath))}
              >
                <span className="tree-icon" aria-hidden>
                  {entry.type === 'dir' ? (isOpen ? '▾' : '▸') : ''}
                </span>
                {entry.name}
                {entry.type === 'dir' && '/'}
              </button>
              {isOpen && renderFolder(entryPath, depth + 1)}
            </li>
          );
        })}
        {listing.truncated && <li className="muted small tree-note">… more files not listed</li>}
        {listing.entries.length === 0 && <li className="muted small tree-note">(empty)</li>}
      </ul>
    );
  }

  if (rootError) {
    return <p className="muted small">{emptyHint ?? `Could not read the folder: ${rootError}`}</p>;
  }

  return (
    <div className="file-browser">
      <nav className="file-tree-pane" aria-label="Files">
        {listings[''] ? renderFolder('', 0) : <p className="muted small">Loading…</p>}
      </nav>
      <section className="file-pane">
        {openPath === undefined ? (
          <p className="muted small">Choose a file to read it. Nothing here can be edited.</p>
        ) : (
          <FileViewer
            path={openPath}
            file={file?.path === openPath ? file : undefined}
            error={fileError}
            onOpenInEditor={() => onOpenInEditor(openPath)}
          />
        )}
      </section>
    </div>
  );
}

const SKIPPED_REASONS = {
  binary: 'This is a binary file, so it is not shown.',
  'too-large': 'This file is too large to show here.',
};

function FileViewer({
  path,
  file,
  error,
  onOpenInEditor,
}: {
  path: string;
  file: FileContent | undefined;
  error: string | undefined;
  onOpenInEditor: () => void;
}) {
  return (
    <>
      <header className="file-header small">
        <code>{path}</code>
        <span className="file-header-actions">
          {file && <span className="muted">{formatSize(file.size)}</span>}
          <button type="button" className="link-button" onClick={onOpenInEditor}>
            Open in VS Code
          </button>
        </span>
      </header>
      {error && <p className="form-error small">{error}</p>}
      {!error && !file && <p className="muted small">Loading…</p>}
      {file?.skipped && <p className="muted small">{SKIPPED_REASONS[file.skipped]}</p>}
      {file && file.content !== null && (
        <pre className="file-view">
          {file.content
            .replace(/\n$/, '')
            .split('\n')
            .map((line, index) => (
              <span key={index} className="file-line">
                {line}
                {'\n'}
              </span>
            ))}
        </pre>
      )}
    </>
  );
}
