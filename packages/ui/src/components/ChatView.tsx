import type { Group } from '@symposium/engine/protocol';
import { useChat } from '../use-chat.ts';
import { Composer } from './Composer.tsx';
import { MessageList } from './MessageList.tsx';

const STATUS_LABELS = { connecting: 'Connecting…', open: 'Live', closed: 'Reconnecting…' };

export function ChatView({ group }: { group: Group }) {
  const { messages, status, loadError, send } = useChat(group.id);

  return (
    <div className="chat">
      <header className="chat-header">
        <h1>{group.name}</h1>
        <span className={`status status-${status}`}>{STATUS_LABELS[status]}</span>
      </header>
      {loadError && <p className="banner-error">Could not load messages: {loadError}</p>}
      <MessageList messages={messages} />
      <Composer onSend={send} />
    </div>
  );
}
