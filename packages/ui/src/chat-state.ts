import type { Message } from '@symposium/engine/protocol';

export interface ChatState {
  /** Messages sorted by id, with no duplicates. */
  messages: Message[];
}

export type ChatAction = { type: 'messagesReceived'; messages: Message[] } | { type: 'reset' };

export const initialChatState: ChatState = { messages: [] };

/**
 * Messages can arrive more than once (the POST response and the WebSocket push carry the same
 * message, and a reconnect catch-up can overlap with live events), so merge by id.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'messagesReceived': {
      const known = new Set(state.messages.map((m) => m.id));
      const fresh = action.messages.filter((m) => !known.has(m.id));
      if (fresh.length === 0) return state;
      const messages = [...state.messages, ...fresh].sort((a, b) => a.id - b.id);
      return { messages };
    }
    case 'reset':
      return initialChatState;
  }
}
