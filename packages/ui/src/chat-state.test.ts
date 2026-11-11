import type { Message } from '@symposium/engine/protocol';
import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState } from './chat-state.ts';

function message(id: number, body = `message ${id}`): Message {
  return { id, groupId: 'g1', authorKind: 'human', authorAgentId: null, body, createdAt: id };
}

describe('chatReducer', () => {
  it('adds received messages', () => {
    const state = chatReducer(initialChatState, {
      type: 'messagesReceived',
      messages: [message(1), message(2)],
    });
    expect(state.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('ignores a message it already has (POST response and WebSocket push)', () => {
    const once = chatReducer(initialChatState, {
      type: 'messagesReceived',
      messages: [message(1)],
    });
    const twice = chatReducer(once, { type: 'messagesReceived', messages: [message(1)] });
    expect(twice.messages).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('keeps messages sorted when they arrive out of order', () => {
    let state = chatReducer(initialChatState, { type: 'messagesReceived', messages: [message(3)] });
    state = chatReducer(state, { type: 'messagesReceived', messages: [message(1), message(2)] });
    expect(state.messages.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('merges a reconnect catch-up that overlaps live events', () => {
    let state = chatReducer(initialChatState, {
      type: 'messagesReceived',
      messages: [message(1), message(2), message(4)],
    });
    state = chatReducer(state, {
      type: 'messagesReceived',
      messages: [message(2), message(3), message(4), message(5)],
    });
    expect(state.messages.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('resets to empty', () => {
    const state = chatReducer(initialChatState, {
      type: 'messagesReceived',
      messages: [message(1)],
    });
    expect(chatReducer(state, { type: 'reset' })).toEqual(initialChatState);
  });
});
