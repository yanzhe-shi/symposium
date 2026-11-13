import type { Agent, Message } from '@symposium/engine/protocol';
import { useEffect, useRef } from 'react';
import { CommandCard } from './CommandCard.tsx';
import { DiffCard } from './DiffCard.tsx';
import { HireProposalCard } from './HireProposalCard.tsx';
import { RichText } from './RichText.tsx';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

interface MessageListProps {
  groupId: string;
  messages: Message[];
  /** Every agent ever in the group, so old messages keep their author's name. */
  agents: Agent[];
  /** Messages still waiting in an inbox, with the names of the busy agents they wait for. */
  queuedFor: Map<number, string[]>;
}

export function MessageList({ groupId, messages, agents, queuedFor }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);
  const names = agents.filter((agent) => agent.firedAt === null).map((agent) => agent.name);

  // Start at the newest message, then follow new ones unless the reader has scrolled up.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 300;
    if (!scrolledOnce.current || nearBottom) {
      list.scrollTop = list.scrollHeight;
      scrolledOnce.current = true;
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="message-list message-list-empty">
        <p>No messages yet. Hire a lead, then tell it what you want to build.</p>
      </div>
    );
  }

  return (
    <div className="message-list" role="log" aria-live="polite" ref={listRef}>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          groupId={groupId}
          message={message}
          agents={agents}
          names={names}
          queuedFor={queuedFor.get(message.id)}
        />
      ))}
    </div>
  );
}

function MessageItem({
  groupId,
  message,
  agents,
  names,
  queuedFor,
}: {
  groupId: string;
  message: Message;
  agents: Agent[];
  names: string[];
  queuedFor: string[] | undefined;
}) {
  const time = (
    <time dateTime={new Date(message.createdAt).toISOString()}>
      {timeFormat.format(message.createdAt)}
    </time>
  );

  if (message.meta?.type === 'diff') {
    return <DiffCard groupId={groupId} message={message} meta={message.meta} agents={agents} />;
  }
  if (message.meta?.type === 'command') {
    return <CommandCard groupId={groupId} message={message} meta={message.meta} agents={agents} />;
  }
  if (message.meta?.type === 'hire-proposal') {
    return <HireProposalCard groupId={groupId} message={message} meta={message.meta} />;
  }
  if (message.authorKind === 'system') {
    const level = message.meta?.type === 'notice' ? message.meta.level : 'info';
    return (
      <div className={`notice notice-${level}`}>
        <RichText text={message.body} names={names} />
        {time}
      </div>
    );
  }

  const author = agents.find((agent) => agent.id === message.authorAgentId);
  return (
    <article className={`message message-${message.authorKind}`}>
      <header className="message-meta">
        <span className="message-author">
          {message.authorKind === 'human' ? 'You' : (author?.name ?? 'Former agent')}
        </span>
        {author && <span className={`role-badge role-${author.role}`}>{author.role}</span>}
        {author?.firedAt != null && <span className="muted">(left)</span>}
        {time}
        {queuedFor && (
          <span
            className="queued-chip"
            title="They are busy. This message is in their inbox and will be read in their next turn. Nothing was stopped."
          >
            queued for {queuedFor.join(', ')}
          </span>
        )}
      </header>
      <RichText text={message.body} names={names} />
    </article>
  );
}
