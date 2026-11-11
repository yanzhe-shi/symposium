import type { Message } from '@symposium/engine/protocol';
import { useEffect, useRef } from 'react';

function authorLabel(message: Message): string {
  switch (message.authorKind) {
    case 'human':
      return 'You';
    case 'system':
      return 'System';
    case 'agent':
      // Agent names arrive with milestone 3.
      return 'Agent';
  }
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function MessageList({ messages }: { messages: Message[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="message-list message-list-empty">
        <p>No messages yet. Say hello to start the project.</p>
      </div>
    );
  }

  return (
    <div className="message-list" role="log" aria-live="polite">
      {messages.map((message) => (
        <article key={message.id} className={`message message-${message.authorKind}`}>
          <header className="message-meta">
            <span className="message-author">{authorLabel(message)}</span>
            <time dateTime={new Date(message.createdAt).toISOString()}>
              {timeFormat.format(message.createdAt)}
            </time>
          </header>
          <p className="message-body">{message.body}</p>
        </article>
      ))}
      <div ref={endRef} />
    </div>
  );
}
