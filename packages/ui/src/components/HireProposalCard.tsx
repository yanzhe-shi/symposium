import type { Message, MessageMeta, ProposalStatus } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';

type ProposalMeta = Extract<MessageMeta, { type: 'hire-proposal' }>;

const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Needs your decision',
  approved: 'Hired',
  rejected: 'Declined',
};

export function HireProposalCard({
  groupId,
  message,
  meta,
}: {
  groupId: string;
  message: Message;
  meta: ProposalMeta;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { hire } = meta;

  async function decide(decision: 'approve-hire' | 'reject-hire'): Promise<void> {
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
    <article className="card proposal-card">
      <header className="card-header">
        <strong>Hire proposal: {hire.name}</strong>
        <span className={`pill pill-${meta.status}`}>{STATUS_LABELS[meta.status]}</span>
      </header>
      <p className="small">{message.body}</p>
      {hire.instructions && <p className="small muted">{hire.instructions}</p>}
      {error && <p className="form-error">{error}</p>}
      {meta.status === 'pending' && (
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void decide('approve-hire')}>
            Hire {hire.name}
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => void decide('reject-hire')}
          >
            Decline
          </button>
        </div>
      )}
    </article>
  );
}
