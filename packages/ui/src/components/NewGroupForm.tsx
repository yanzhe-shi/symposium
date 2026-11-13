import type { FolderChoices, Group } from '@symposium/engine/protocol';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { projectFolderFor } from '../text-format.ts';

interface NewGroupFormProps {
  firstGroup: boolean;
  onCreated: (group: Group) => void;
  onCancel?: () => void;
}

export function NewGroupForm({ firstGroup, onCreated, onCancel }: NewGroupFormProps) {
  const [name, setName] = useState('');
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
      onCreated(await api.createGroup({ name: name.trim(), folderPath: folderPath.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="panel-form centered-form" onSubmit={submit}>
      <h1>{firstGroup ? 'Start your first project' : 'New group'}</h1>
      <p className="muted">
        Each group is one project: a chat, a folder and a team of agents you hire. Symposium creates
        the folder and a git repo if they don't exist yet.
      </p>
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
