import type { Message, MessageMeta, ProposalStatus, RoleInfo } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';
import { Avatar } from './Avatar.tsx';
import { RichText } from './RichText.tsx';
import { roleLabel } from './RoleBadge.tsx';

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
  roles,
}: {
  groupId: string;
  message: Message;
  meta: ProposalMeta;
  roles: RoleInfo[];
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
    <article className={`card proposal-card proposal-${meta.status}`}>
      <header className="card-header">
        <Avatar name={hire.name} size="small" />
        <div className="card-title">
          <strong>
            Hire proposal: {hire.name}{' '}
            <span className={`role-badge role-${hire.role}`}>
              {meta.newRole?.title ??
                roleLabel({ role: hire.role, roleId: hire.roleId ?? hire.role }, roles)}
            </span>
          </strong>
          <span className="muted small card-subtitle">
            {hire.provider} · {hire.model}
          </span>
        </div>
        <span className={`pill pill-${meta.status}`}>{STATUS_LABELS[meta.status]}</span>
      </header>
      <p className="small">{message.body}</p>
      {hire.instructions && <p className="small muted">{hire.instructions}</p>}
      {meta.newRole && (
        <details className="new-role">
          <summary>
            New role: <strong>{meta.newRole.title}</strong>, works like a {meta.newRole.kind}
            {meta.status === 'pending' && '. Hiring adds the role.'}
          </summary>
          {meta.newRole.summary && <p className="small">{meta.newRole.summary}</p>}
          <RichText text={meta.newRole.text} names={[]} />
        </details>
      )}
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
