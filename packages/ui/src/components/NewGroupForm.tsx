import type {
  FolderChoices,
  Group,
  ProviderId,
  ProviderInfo,
  SystemInfo,
} from '@symposium/engine/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { projectFolderFor } from '../text-format.ts';
import { InlineText } from './RichText.tsx';

/** The providers a starter team can be hired on. Mirrors STARTER_PROVIDERS in the engine. */
const STARTER_PROVIDERS: ProviderId[] = ['claude-code', 'antigravity', 'mock'];
const NO_TEAM = 'none';

/** What a new user needs, and whether this computer has it. */
function SetupChecks({ system }: { system: SystemInfo }) {
  const checks: { label: string; ok: boolean; missing: string }[] = [
    {
      label: 'git',
      ok: system.git,
      missing: 'Needed. Install git with your package manager, then start Symposium again.',
    },
    {
      label: 'Claude Code',
      ok: system.providers['claude-code'],
      missing: 'Install the `claude` command and log in once by running it in a terminal.',
    },
    {
      label: 'Antigravity',
      ok: system.providers.antigravity,
      missing: 'Optional. Install the `agy` command and log in to use Gemini models.',
    },
    {
      label: 'VS Code',
      ok: system.vscode,
      missing: 'Optional. Needed only for the Open in VS Code buttons.',
    },
  ];
  const noAgents = !system.providers['claude-code'] && !system.providers.antigravity;
  return (
    <div className="setup-checks">
      <ul>
        {checks.map((check) => (
          <li key={check.label} className={check.ok ? 'check-ok' : 'check-missing'}>
            <span className="check-mark" aria-hidden>
              {check.ok ? '✓' : '–'}
            </span>
            <span>
              <strong>{check.label}</strong> {check.ok ? 'found' : 'not found'}
              {!check.ok && (
                <span className="muted">
                  . <InlineText text={check.missing} />
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {noAgents && (
        <p className="muted small">
          No agent program was found. You can still look around with the Mock team, which answers
          without any AI, or hire agents on a local model through an OpenAI-compatible API.
        </p>
      )}
    </div>
  );
}

interface NewGroupFormProps {
  firstGroup: boolean;
  providers: ProviderInfo[];
  /** What is installed here. Undefined if the engine could not say. */
  system: SystemInfo | undefined;
  onCreated: (group: Group) => void;
  onCancel?: () => void;
}

export function NewGroupForm({
  firstGroup,
  providers,
  system,
  onCreated,
  onCancel,
}: NewGroupFormProps) {
  const [name, setName] = useState('');
  const teamChoices = providers.filter((provider) => STARTER_PROVIDERS.includes(provider.id));
  // A team on the first agent program found here. With none installed, the human chooses.
  const [team, setTeam] = useState<string>(
    () =>
      teamChoices.find((provider) => provider.id !== 'mock' && system?.providers[provider.id])
        ?.id ?? NO_TEAM,
  );
  // Undefined until the human types or picks a folder: until then it follows the name.
  const [chosenFolder, setChosenFolder] = useState<string>();
  const [projectsFolder, setProjectsFolder] = useState<string>();
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    api
      .projectsFolder()
      .then((folder) => {
        if (active) setProjectsFolder(folder.path);
      })
      // Without it the folder is simply typed by hand, as before.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const suggested = projectsFolder ? projectFolderFor(projectsFolder, name) : '';
  const folderPath = chosenFolder ?? suggested;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onCreated(
        await api.createGroup({
          name: name.trim(),
          folderPath: folderPath.trim(),
          ...(team === NO_TEAM ? {} : { starterTeam: team as ProviderId }),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="panel-form centered-form" onSubmit={submit}>
      <h1>{firstGroup ? 'Welcome to Symposium' : 'New group'}</h1>
      <p className="muted">
        {firstGroup && 'Start your first project. '}
        Each group is one project: a chat, a folder and a team of agents you hire. Symposium creates
        the folder and a git repo if they don't exist yet.
      </p>
      {system &&
        (firstGroup ||
          !system.git ||
          (!system.providers['claude-code'] && !system.providers.antigravity)) && (
          <SetupChecks system={system} />
        )}
      <label>
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Sock shop"
          maxLength={80}
          required
          autoFocus
        />
      </label>
      <label>
        Project folder
        <span className="input-with-button">
          <input
            value={folderPath}
            onChange={(event) => setChosenFolder(event.target.value)}
            placeholder={
              projectsFolder ? `${projectsFolder}/sock-shop` : '/home/you/projects/sock-shop'
            }
            required
          />
          <button type="button" className="button-secondary" onClick={() => setBrowsing(true)}>
            Browse…
          </button>
        </span>
      </label>
      <p className="muted small">
        {chosenFolder === undefined
          ? 'A new folder named after the project. Type or browse to use another, such as a project you already have.'
          : 'An absolute path. A folder that does not exist yet is created.'}
        {chosenFolder !== undefined && suggested && (
          <>
            {' '}
            <button
              type="button"
              className="link-button"
              onClick={() => setChosenFolder(undefined)}
            >
              Use the suggested folder
            </button>
          </>
        )}
      </p>
      <label>
        Team
        <select value={team} onChange={(event) => setTeam(event.target.value)}>
          {teamChoices.map((provider) => (
            <option key={provider.id} value={provider.id}>
              Lead, worker, reviewer and scribe on {provider.label}
              {system && !system.providers[provider.id] ? ' (not found on this computer)' : ''}
            </option>
          ))}
          <option value={NO_TEAM}>No team yet: I will hire them myself</option>
        </select>
      </label>
      <p className="muted small">
        {team === NO_TEAM
          ? 'Hire a lead first in the Team panel, then the rest.'
          : 'Lea, Ada, Rex and Sam are hired with the group. You can change their models and permissions, hire more or fire anyone in the Team panel.'}
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        {onCancel && (
          <button type="button" className="button-secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy || !name.trim() || !folderPath.trim()}>
          {busy ? 'Creating…' : 'Create group'}
        </button>
      </div>
      {browsing && (
        <FolderPicker
          startAt={chosenFolder}
          onPick={(path) => {
            setChosenFolder(path);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </form>
  );
}

interface FolderPickerProps {
  /** Where to start. Left out, or not a folder: where projects usually go. */
  startAt: string | undefined;
  onPick: (path: string) => void;
  onClose: () => void;
}

/** Walks the folders on this machine and picks one. Shows folder names only. */
function FolderPicker({ startAt, onPick, onClose }: FolderPickerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [wanted, setWanted] = useState(startAt?.trim() || undefined);
  const [choices, setChoices] = useState<FolderChoices>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  useEffect(() => {
    let active = true;
    api
      .folderChoices(wanted)
      .then((listing) => {
        if (!active) return;
        setChoices(listing);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!active) return;
        // A typed path that is not a folder yet: start from the usual place instead.
        if (wanted !== undefined && choices === undefined) setWanted(undefined);
        else setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
    // `choices` is only read to tell the first load from later ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  return (
    <dialog ref={dialogRef} className="dialog folder-picker" onClose={onClose}>
      <h2>Choose a folder</h2>
      <p className="small folder-picker-path">
        <code>{choices?.path ?? 'Loading…'}</code>
      </p>
      {error && <p className="form-error small">{error}</p>}
      <ul className="folder-list">
        {choices?.parent && (
          <li>
            <button type="button" className="tree-item" onClick={() => setWanted(choices.parent!)}>
              ↑ Up one folder
            </button>
          </li>
        )}
        {choices?.dirs.map((dir) => (
          <li key={dir}>
            <button
              type="button"
              className="tree-item"
              onClick={() => setWanted(`${choices.path.replace(/\/$/, '')}/${dir}`)}
            >
              {dir}/
            </button>
          </li>
        ))}
        {choices && choices.dirs.length === 0 && (
          <li className="muted small tree-note">No folders in here.</li>
        )}
        {choices?.truncated && <li className="muted small tree-note">… more folders not listed</li>}
      </ul>
      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" disabled={!choices} onClick={() => choices && onPick(choices.path)}>
          Use this folder
        </button>
      </div>
    </dialog>
  );
}
