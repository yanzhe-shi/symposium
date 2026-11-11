import type { Agent, Group } from '@symposium/engine/protocol';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';

/** Shows and edits an agent's private memory file. */
export function MemoryDialog({
  group,
  agent,
  onClose,
}: {
  group: Group;
  agent: Agent;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
    let active = true;
    api
      .memory(group.id, agent.id)
      .then((result) => {
        if (active) setDraft(result.content);
      })
      .catch((err: unknown) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [group.id, agent.id]);

  async function save(): Promise<void> {
    if (draft === undefined) return;
    setSaving(true);
    try {
      await api.saveMemory(group.id, agent.id, draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <h2>{agent.name}'s memory</h2>
      <p className="muted small">
        Notes {agent.name} saved with <code>```memory</code> blocks. They are included in every
        turn. You can edit or clear them.
      </p>
      {error && <p className="form-error">{error}</p>}
      <textarea
        className="memory-editor"
        value={draft ?? ''}
        placeholder={draft === undefined ? 'Loading…' : 'Nothing saved yet.'}
        onChange={(event) => setDraft(event.target.value)}
        disabled={draft === undefined}
        aria-label={`${agent.name}'s memory`}
      />
      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={onClose}>
          Close
        </button>
        <button type="button" disabled={saving || draft === undefined} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </dialog>
  );
}
