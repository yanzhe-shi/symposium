import type { Group } from '@symposium/engine/protocol';
import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';

interface NewGroupFormProps {
  firstGroup: boolean;
  onCreated: (group: Group) => void;
  onCancel?: () => void;
}

export function NewGroupForm({ firstGroup, onCreated, onCancel }: NewGroupFormProps) {
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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
        Project folder (absolute path)
        <input
          value={folderPath}
          onChange={(event) => setFolderPath(event.target.value)}
          placeholder="/home/you/projects/sock-shop"
          required
        />
      </label>
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
    </form>
  );
}
