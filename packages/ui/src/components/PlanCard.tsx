import type { Agent, Message, MessageMeta, PlanStatus } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import { Avatar } from './Avatar.tsx';

type PlanMeta = Extract<MessageMeta, { type: 'plan' }>;

const STATUS_LABELS: Record<PlanStatus, string> = {
  pending: 'Needs your decision',
  approved: 'Approved',
  declined: 'Declined',
};

interface PlanCardProps {
  groupId: string;
  message: Message;
  meta: PlanMeta;
  agents: Agent[];
}

/**
 * The lead wants to hand out work. Its message, just above this card, reaches nobody until the
 * human approves here.
 */
export function PlanCard({ groupId, message, meta, agents }: PlanCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name;
  const leadName = nameOf(meta.leadId) ?? 'The lead';
  const recipients = meta.recipientIds.map(nameOf).filter((name) => name !== undefined);

  async function decide(decision: 'approve-plan' | 'decline-plan'): Promise<void> {
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
    <article className={`card plan-card plan-${meta.status}`}>
      <header className="card-header">
        <Avatar name={leadName} size="small" />
        <div className="card-title">
          <strong>
            {leadName}
            {meta.status === 'pending' ? ' wants to start work' : "'s plan"}
          </strong>
          <span className="muted small card-subtitle">
            {recipients.length > 0 ? `Hands work to ${recipients.join(', ')}` : 'Hands out work'}
          </span>
        </div>
        <span className={`pill pill-${meta.status}`}>{STATUS_LABELS[meta.status]}</span>
      </header>
      {meta.status === 'pending' && (
        <p className="small muted">
          The plan is in {leadName}'s message above. Nobody starts until you approve it. To change
          it, decline and say what you want instead.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
      {meta.status === 'pending' && (
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void decide('approve-plan')}>
            Approve plan
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => void decide('decline-plan')}
          >
            Decline
          </button>
        </div>
      )}
    </article>
  );
}
