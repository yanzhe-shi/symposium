import type { Agent, Message, RoleInfo } from '@symposium/engine/protocol';
import { Fragment, useEffect, useRef } from 'react';
import { Avatar } from './Avatar.tsx';
import { CommandCard } from './CommandCard.tsx';
import { DiffCard } from './DiffCard.tsx';
import { HireProposalCard } from './HireProposalCard.tsx';
import { PlanCard } from './PlanCard.tsx';
import { Logo } from './icons.tsx';
import { RichText } from './RichText.tsx';
import { RoleBadge } from './RoleBadge.tsx';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});
/** Messages from one author this close together are shown under one name. */
const SAME_BREATH_MS = 5 * 60_000;

const dayOf = (time: number): string => new Date(time).toDateString();

function dayLabel(time: number): string {
  const today = new Date();
  if (dayOf(time) === today.toDateString()) return 'Today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayOf(time) === yesterday.toDateString()) return 'Yesterday';
  return dayFormat.format(time);
}

/** A plain chat message, as opposed to a card or a system notice. */
const isChat = (message: Message): boolean =>
  message.authorKind !== 'system' && message.meta === null;

/** True when a message directly follows another by the same author, so its header can go. */
function continues(message: Message, previous: Message | undefined): boolean {
  return (
    previous !== undefined &&
    isChat(message) &&
    isChat(previous) &&
    previous.authorKind === message.authorKind &&
    previous.authorAgentId === message.authorAgentId &&
    message.createdAt - previous.createdAt < SAME_BREATH_MS &&
    dayOf(previous.createdAt) === dayOf(message.createdAt)
  );
}

interface MessageListProps {
  groupId: string;
  messages: Message[];
  /** Every agent ever in the group, so old messages keep their author's name. */
  agents: Agent[];
  /** Every role, to name the custom ones. */
  roles: RoleInfo[];
  /** Messages still waiting in an inbox, with the names of the busy agents they wait for. */
  queuedFor: Map<number, string[]>;
}

export function MessageList({ groupId, messages, agents, roles, queuedFor }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // True while the reader is at the newest message. Scrolling up lets go of it.
  const pinned = useRef(true);
  const names = agents.filter((agent) => agent.firedAt === null).map((agent) => agent.name);
  const empty = messages.length === 0;

  // Start at the newest message, then follow new ones unless the reader has scrolled up.
  useEffect(() => {
    const list = listRef.current;
    if (list && pinned.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  // Stay at the newest message when the list changes size, as when the working bar appears.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [empty]);

  function handleScroll(): void {
    const list = listRef.current;
    if (list) pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 150;
  }

  if (empty) {
    return (
      <div className="message-list message-list-empty">
        <div className="empty-state">
          <Logo size={44} />
          <h2>Nothing here yet</h2>
          <p>Hire a lead in the Team panel, then tell it what you want to build.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="message-list"
      role="log"
      aria-live="polite"
      ref={listRef}
      onScroll={handleScroll}
    >
      <div className="message-column">
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const newDay = !previous || dayOf(previous.createdAt) !== dayOf(message.createdAt);
          return (
            <Fragment key={message.id}>
              {newDay && (
                <div className="day-divider" role="separator">
                  <span>{dayLabel(message.createdAt)}</span>
                </div>
              )}
              <MessageItem
                groupId={groupId}
                message={message}
                agents={agents}
                roles={roles}
                names={names}
                queuedFor={queuedFor.get(message.id)}
                continued={continues(message, previous)}
              />
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

function MessageItem({
  groupId,
  message,
  agents,
  roles,
  names,
  queuedFor,
  continued,
}: {
  groupId: string;
  message: Message;
  agents: Agent[];
  roles: RoleInfo[];
  names: string[];
  queuedFor: string[] | undefined;
  /** Follows a message by the same author: the avatar and the name are left out. */
  continued: boolean;
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
  if (message.meta?.type === 'plan') {
    return <PlanCard groupId={groupId} message={message} meta={message.meta} agents={agents} />;
  }
  if (message.meta?.type === 'hire-proposal') {
    return (
      <HireProposalCard groupId={groupId} message={message} meta={message.meta} roles={roles} />
    );
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

  const queuedChip = queuedFor && (
    <span
      className="queued-chip"
      title="They are busy. This message is in their inbox and will be read in their next turn. Nothing was stopped."
    >
      queued for {queuedFor.join(', ')}
    </span>
  );

  if (message.authorKind === 'human') {
    return (
      <article className={`message message-human${continued ? ' message-continued' : ''}`}>
        <div className="bubble">
          <RichText text={message.body} names={names} />
        </div>
        <footer className="message-meta">
          {queuedChip}
          <span className="visually-hidden">You, </span>
          {time}
        </footer>
      </article>
    );
  }

  const author = agents.find((agent) => agent.id === message.authorAgentId);
  const name = author?.name ?? 'Former agent';
  return (
    <article className={`message message-agent${continued ? ' message-continued' : ''}`}>
      <div className="message-gutter">{!continued && <Avatar name={name} />}</div>
      <div className="message-body">
        {!continued && (
          <header className="message-meta">
            <span className="message-author">{name}</span>
            {author && <RoleBadge agent={author} roles={roles} />}
            {author?.firedAt != null && <span className="muted">left the team</span>}
            {time}
            {queuedChip}
          </header>
        )}
        <RichText text={message.body} names={names} />
        {continued && queuedChip}
      </div>
    </article>
  );
}
