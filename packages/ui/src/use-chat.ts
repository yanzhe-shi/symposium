import type { Message } from '@symposium/engine/protocol';
import { useCallback, useEffect, useReducer, useState } from 'react';
import {
  connectChat,
  fetchMessages,
  MAX_PAGE_SIZE,
  postMessage,
  type ConnectionStatus,
} from './api.ts';
import { chatReducer, initialChatState } from './chat-state.ts';

export interface UseChat {
  messages: Message[];
  status: ConnectionStatus;
  loadError: string | undefined;
  send: (body: string) => Promise<void>;
}

export function useChat(groupId: string): UseChat {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    dispatch({ type: 'reset' });
    let active = true;
    // Newest id seen from the engine for this group; a reconnect fetches everything after it.
    let lastId: number | undefined;

    function receive(messages: Message[]): void {
      if (!active || messages.length === 0) return;
      dispatch({ type: 'messagesReceived', messages });
      lastId = Math.max(lastId ?? 0, ...messages.map((m) => m.id));
    }

    async function catchUp(): Promise<void> {
      try {
        if (lastId === undefined) {
          receive(await fetchMessages(groupId));
        } else {
          // Page through everything missed while disconnected.
          for (;;) {
            const page = await fetchMessages(groupId, { afterId: lastId, limit: MAX_PAGE_SIZE });
            receive(page);
            if (!active || page.length < MAX_PAGE_SIZE) break;
          }
        }
        if (active) setLoadError(undefined);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      }
    }

    // Load history right away rather than waiting for the socket, so the chat still shows
    // its messages if the live connection is slow or failing. Duplicates are merged by id.
    void catchUp();
    const stop = connectChat(groupId, {
      onOpen: () => void catchUp(),
      onEvent: (event) => {
        if (event.type === 'message.created') receive([event.message]);
      },
      onStatusChange: setStatus,
    });

    return () => {
      active = false;
      stop();
    };
  }, [groupId]);

  const send = useCallback(
    async (body: string) => {
      const message = await postMessage(groupId, body);
      dispatch({ type: 'messagesReceived', messages: [message] });
    },
    [groupId],
  );

  return { messages: state.messages, status, loadError, send };
}
