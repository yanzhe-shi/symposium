import type { Group } from '@symposium/engine/protocol';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { RichText } from './RichText.tsx';

/** Shows the group's project.md, reloading when the scribe updates it. Editable by hand. */
export function ProjectPanel({ group, version }: { group: Group; version: number }) {
  const [content, setContent] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .project(group.id)
      .then((result) => {
        if (active) setContent(result.content);
      })
      .catch((err: unknown) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [group.id, version]);

  async function save(): Promise<void> {
    if (draft === undefined) return;
    setSaving(true);
    try {
      setContent((await api.saveProject(group.id, draft)).content);
      setDraft(undefined);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="project-panel">
      <p className="muted small">
        Every agent reads this before working. The scribe updates it when the team goes quiet.
      </p>
      {error && <p className="form-error">{error}</p>}
      {draft === undefined ? (
        <>
          <div className="project-text">
            {content === undefined ? 'Loading…' : <RichText text={content} names={[]} />}
          </div>
          <button
            type="button"
            className="button-secondary"
            onClick={() => setDraft(content ?? '')}
          >
            Edit
          </button>
        </>
      ) : (
        <>
          <textarea
            className="project-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="project.md"
          />
          <div className="form-actions">
            <button type="button" className="button-secondary" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
