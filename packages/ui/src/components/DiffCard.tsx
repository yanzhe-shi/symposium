import type {
  Agent,
  CheckResult,
  CheckStatus,
  DiffStatus,
  Message,
  MessageMeta,
  ReviewResult,
} from '@symposium/engine/protocol';
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

const CHECK_LABELS: Record<CheckStatus, string> = {
  running: 'Check running…',
  passed: 'Check passed',
  failed: 'Check failed',
  'timed-out': 'Check took too long',
  stopped: 'Check stopped',
  error: 'Check could not start',
};

/** "12 s", "2 min 5 s". */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** How the group's check command went on this change, with its output on request. */
function CheckLine({ check }: { check: CheckResult }) {
  const summary = (
    <>
      <span className={`pill pill-check-${check.status}`}>{CHECK_LABELS[check.status]}</span>
      <code className="check-command">{check.command}</code>
      {check.status !== 'running' && (
        <span className="muted small">
          {check.exitCode !== null && check.exitCode !== 0 ? `exit code ${check.exitCode} · ` : ''}
          {duration(check.durationMs)}
        </span>
      )}
    </>
  );
  if (!check.output.trim()) return <div className="check-line">{summary}</div>;
  return (
    <details className="check-details" open={check.status === 'failed'}>
      <summary className="check-line">{summary}</summary>
      <pre className="check-output">{check.output}</pre>
    </details>
  );
}

/** What a reviewer made of this change. The review itself is the reviewer's message in the chat. */
function ReviewLine({ review, agents }: { review: ReviewResult; agents: Agent[] }) {
  const name = agents.find((agent) => agent.id === review.reviewerId)?.name ?? 'A reviewer';
  const label = {
    running: `${name} is reviewing…`,
    approved: `${name} approved`,
    changes: `${name} asks for changes`,
    unclear: `${name} gave no verdict`,
    failed: `${name}'s review failed`,
    stopped: 'Review stopped',
  }[review.status];
  return (
    <div className="check-line">
      <span className={`pill pill-review-${review.status}`}>{label}</span>
      {review.messageId !== undefined && (
        <span className="muted small">The review is {name}'s message below.</span>
      )}
    </div>
  );
}

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
  // The check failed or the reviewer wants changes: merging is still the human's call.
  const doubtful =
    (meta.check !== undefined && !['passed', 'running'].includes(meta.check.status)) ||
    meta.review?.status === 'changes';

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
      {meta.check && <CheckLine check={meta.check} />}
      {meta.review && <ReviewLine review={meta.review} agents={agents} />}
      {error && <p className="form-error">{error}</p>}
      {meta.status === 'pending' && (
        <div className="card-actions">
          <button type="button" disabled={busy} onClick={() => void decide('merge')}>
            {doubtful ? 'Merge anyway' : `Merge into ${meta.baseBranch}`}
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
