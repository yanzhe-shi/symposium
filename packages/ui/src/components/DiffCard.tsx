import type { Agent, DiffStatus, Message, MessageMeta } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import { DiffView } from './DiffView.tsx';

type DiffMeta = Extract<MessageMeta, { type: 'diff' }>;

const STATUS_LABELS: Record<DiffStatus, string> = {
  pending: 'Waiting for your review',
  merged: 'Merged',
  discarded: 'Discarded',
  superseded: 'Replaced by a newer diff',
};

interface DiffCardProps {
  groupId: string;
  message: Message;
  meta: DiffMeta;
  agents: Agent[];
}

export function DiffCard({ groupId, message, meta, agents }: DiffCardProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const agentName = agents.find((agent) => agent.id === meta.agentId)?.name ?? 'Agent';

  async function decide(decision: 'merge' | 'discard'): Promise<void> {
    if (
      decision === 'discard' &&
      !confirm(
        `Discard all of ${agentName}'s unmerged work on ${meta.branch}? This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.decide(groupId, message.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card diff-card diff-${meta.status}`}>
      <header className="card-header">
        <strong>
          {agentName}'s changes · {meta.files.length} file{meta.files.length === 1 ? '' : 's'}
        </strong>
        <span className={`pill pill-${meta.status}`}>{STATUS_LABELS[meta.status]}</span>
      </header>
      <p className="muted small">
        <code>{meta.branch}</code> → <code>{meta.baseBranch}</code> · {meta.commit.slice(0, 7)}
      </p>
      <pre className="diff-stat">{meta.stat}</pre>
      <button type="button" className="link-button" onClick={() => setOpen(!open)}>
        {open ? 'Hide diff' : 'Show diff'}
      </button>
      {open && <DiffView diff={meta.diff} truncated={meta.truncated} />}
      {error && <p className="form-error">{error}</p>}
      {meta.status === 'pending' && (
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void decide('merge')}>
            Merge into {meta.baseBranch}
          </button>
          <button
            type="button"
            className="button-danger"
            disabled={busy}
            onClick={() => void decide('discard')}
          >
            Discard
          </button>
        </div>
      )}
    </article>
  );
}
