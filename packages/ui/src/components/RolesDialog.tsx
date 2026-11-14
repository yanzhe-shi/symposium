import type { RoleDraft, RoleInfo, RoleKind } from '@symposium/engine/protocol';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';

const KIND_HELP: Record<RoleKind, string> = {
  lead: 'Lead: gets your messages, sees the whole chat and assigns work. One per team.',
  worker: 'Worker: edits files in its own git worktree and may ask to run commands.',
  reviewer: 'Reviewer: reads the project but does not change it.',
  scribe: 'Scribe: keeps project.md up to date when the team goes quiet. One per team.',
};
const KINDS = Object.keys(KIND_HELP) as RoleKind[];

const NEW_ROLE: RoleDraft = { title: '', kind: 'worker', summary: '', text: '' };

/**
 * Where the human reads, rewrites and adds roles. A role is a job description: it becomes part
 * of the instructions of every agent hired into it, from that agent's next turn.
 */
export function RolesDialog({
  roles,
  onChanged,
  onClose,
}: {
  roles: RoleInfo[];
  /** Called after a role was saved or removed, so the role list can be read again. */
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The id of the role being edited, or `null` for a new one.
  const [selectedId, setSelectedId] = useState<string | null>(roles[0]?.id ?? null);
  const selected = roles.find((role) => role.id === selectedId);
  const [draft, setDraft] = useState<RoleDraft>(selected ?? NEW_ROLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  function choose(role: RoleInfo | null): void {
    setSelectedId(role?.id ?? null);
    setDraft(role ?? NEW_ROLE);
    setError(undefined);
    setSaved(false);
  }

  const change = (changes: Partial<RoleDraft>): void => {
    setDraft({ ...draft, ...changes });
    setSaved(false);
  };

  async function attempt(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const save = (): Promise<void> =>
    attempt(async () => {
      const role = selected
        ? await api.updateRole(selected.id, {
            title: draft.title,
            summary: draft.summary,
            text: draft.text,
          })
        : await api.createRole(draft);
      await onChanged();
      setSelectedId(role.id);
      setDraft(role);
      setSaved(true);
    });

  const remove = (role: RoleInfo): Promise<void> =>
    attempt(async () => {
      const question = role.builtIn
        ? `Put the ${role.title} role back to the job description it came with? Your changes are lost.`
        : `Delete the role "${role.title}"?`;
      if (!confirm(question)) return;
      const remaining = await api.removeRole(role.id);
      await onChanged();
      choose(remaining.find((other) => other.id === role.id) ?? remaining[0] ?? null);
    });

  const unchanged =
    selected !== undefined &&
    selected.title === draft.title &&
    selected.summary === draft.summary &&
    selected.text === draft.text;

  return (
    <dialog ref={dialogRef} className="dialog roles-dialog" onClose={onClose}>
      <h2>Roles</h2>
      <p className="muted small">
        A role is a job description. Agents hired into it follow it from their next turn, in every
        group. You can also ask your lead to write a role and propose someone for it.
      </p>
      <div className="roles-layout">
        <nav className="roles-list" aria-label="Roles">
          {roles.map((role) => (
            <button
              key={role.id}
              type="button"
              className={`tree-item${role.id === selectedId ? ' tree-item-open' : ''}`}
              onClick={() => choose(role)}
            >
              {role.title}
              {role.edited && <span className="muted"> · edited</span>}
              {!role.builtIn && <span className="muted"> · yours</span>}
            </button>
          ))}
          <button
            type="button"
            className={`tree-item${selectedId === null ? ' tree-item-open' : ''}`}
            onClick={() => choose(null)}
          >
            + New role
          </button>
        </nav>
        <div className="panel-form roles-editor">
          {selected?.builtIn ? (
            <p className="small">
              <strong>{selected.title}</strong> is built in. {KIND_HELP[selected.kind]}
            </p>
          ) : (
            <>
              <label>
                Name
                <input
                  value={draft.title}
                  maxLength={40}
                  placeholder="Designer"
                  onChange={(event) => change({ title: event.target.value })}
                />
              </label>
              <label>
                Works like a
                <select
                  value={draft.kind}
                  disabled={selected !== undefined}
                  onChange={(event) => change({ kind: event.target.value as RoleKind })}
                >
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">
                {KIND_HELP[draft.kind]} This sets what Symposium lets the agent do.
                {selected && ' It cannot change once the role exists.'}
              </p>
            </>
          )}
          <label>
            Summary (one line, shown when hiring)
            <input
              value={draft.summary}
              maxLength={200}
              placeholder="Designs the screens and writes the CSS."
              onChange={(event) => change({ summary: event.target.value })}
            />
          </label>
          <label>
            Job description (Markdown)
            <textarea
              className="role-editor"
              value={draft.text}
              placeholder={
                'You design the product’s screens.\n\n## How you work\n\n- Sketch the layout before writing CSS.\n- …'
              }
              onChange={(event) => change({ text: event.target.value })}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions">
            {selected && (selected.edited || !selected.builtIn) && (
              <button
                type="button"
                className="button-danger roles-remove"
                disabled={busy}
                onClick={() => void remove(selected)}
              >
                {selected.builtIn ? 'Reset to built-in' : 'Delete role'}
              </button>
            )}
            <button type="button" className="button-secondary" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              disabled={busy || unchanged || draft.title.trim() === '' || draft.text.trim() === ''}
              onClick={() => void save()}
            >
              {saved && unchanged ? 'Saved' : selected ? 'Save' : 'Add role'}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
