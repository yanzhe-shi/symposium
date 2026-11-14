import type { Agent, DiffStatus, Message, MessageMeta } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import { parseDiffStat } from '../markdown.ts';
import { Avatar } from './Avatar.tsx';
import { DiffView } from './DiffView.tsx';
import { BranchIcon } from './icons.tsx';

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

  const stat = parseDiffStat(meta.stat);

  return (
    <article className={`card diff-card diff-${meta.status}`}>
      <header className="card-header">
        <Avatar name={agentName} size="small" />
        <div className="card-title">
          <strong>{agentName}'s changes</strong>
          <span className="muted small card-subtitle">
            <BranchIcon /> <code>{meta.branch}</code> → <code>{meta.baseBranch}</code> ·{' '}
            {meta.commit.slice(0, 7)}
          </span>
        </div>
        <span className={`pill pill-${meta.status}`}>{STATUS_LABELS[meta.status]}</span>
      </header>
      {stat.files.length > 0 ? (
        <ul className="diff-stat">
          {stat.files.map((file) => (
            <li key={file.path}>
              <code className="diff-stat-path">{file.path}</code>
              <span className="muted small">{file.changes}</span>
              <span className="diff-stat-bar" aria-hidden>
                <span className="diff-stat-add">{'+'.repeat(file.added)}</span>
                <span className="diff-stat-remove">{'−'.repeat(file.removed)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <pre className="diff-stat-text">{meta.stat}</pre>
      )}
      <div className="card-footer">
        <span className="muted small">{stat.summary}</span>
        <button
          type="button"
          className="link-button small"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide diff' : 'Show diff'}
        </button>
      </div>
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
