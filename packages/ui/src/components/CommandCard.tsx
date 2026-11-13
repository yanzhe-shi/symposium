import type { Agent, CommandStatus, Message, MessageMeta } from '@symposium/engine/protocol';
import { useState } from 'react';
import { api } from '../api.ts';

type CommandMeta = Extract<MessageMeta, { type: 'command' }>;
type Choice = 'allow-command' | 'always-allow-command' | 'deny-command';

const STATUS_LABELS: Record<CommandStatus, string> = {
  pending: 'Needs your decision',
  allowed: 'Allowed',
  denied: 'Denied',
  expired: 'Not answered in time',
  cancelled: 'Cancelled',
};

interface CommandCardProps {
  groupId: string;
  message: Message;
  meta: CommandMeta;
  agents: Agent[];
}

/** An agent wants to run a terminal command. Only that agent waits for the answer. */
export function CommandCard({ groupId, message, meta, agents }: CommandCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const agentName = agents.find((agent) => agent.id === meta.agentId)?.name ?? 'An agent';

  async function decide(choice: Choice): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await api.decide(groupId, message.id, choice);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card command-card command-${meta.status}`}>
      <header className="card-header">
        <strong>{agentName} wants to run a command</strong>
        <span className={`pill pill-${meta.status}`}>
          {STATUS_LABELS[meta.status]}
          {meta.always ? ' · always' : ''}
        </span>
      </header>
      <pre className="command-text">{meta.command}</pre>
      <p className="muted small">
        In {meta.folder}. {meta.reason}
      </p>
      {error && <p className="form-error">{error}</p>}
      {meta.status === 'pending' && (
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void decide('allow-command')}>
            Allow once
          </button>
          {meta.patterns.length > 0 && (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              title={`Adds to ${agentName}'s allow-list: ${meta.patterns.join(' · ')}`}
              onClick={() => void decide('always-allow-command')}
            >
              Always allow
            </button>
          )}
          <button
            type="button"
            className="button-danger"
            disabled={busy}
            onClick={() => void decide('deny-command')}
          >
            Deny
          </button>
        </div>
      )}
    </article>
  );
}
