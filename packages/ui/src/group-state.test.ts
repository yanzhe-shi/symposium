import type { Agent, Message } from '@symposium/engine/protocol';
import { describe, expect, it } from 'vitest';
import {
  activeAgents,
  groupReducer,
  initialGroupState,
  mergeMessages,
  workingAgents,
} from './group-state.ts';

function message(id: number, body = `message ${id}`): Message {
  return {
    id,
    groupId: 'g1',
    authorKind: 'human',
    authorAgentId: null,
    body,
    meta: null,
    createdAt: id,
  };
}

function agent(id: string, firedAt: number | null = null): Agent {
  return {
    id,
    groupId: 'g1',
    name: id,
    provider: 'mock',
    model: 'mock',
    role: 'worker',
    instructions: '',
    options: {},
    createdAt: 0,
    firedAt,
  };
}

describe('mergeMessages', () => {
  it('adds new messages and keeps them sorted', () => {
    const merged = mergeMessages([message(3)], [message(1), message(2)]);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('returns the same array when nothing changed (POST response and push)', () => {
    const current = [message(1)];
    expect(mergeMessages(current, [message(1)])).toBe(current);
  });

  it('replaces a message whose content changed, such as a merged diff', () => {
    const updated = { ...message(1), meta: { type: 'notice' as const, level: 'info' as const } };
    expect(mergeMessages([message(1)], [updated])[0]).toBe(updated);
  });

  it('merges a reconnect catch-up that overlaps live events', () => {
    const merged = mergeMessages(
      [message(1), message(2), message(4)],
      [message(2), message(3), message(4), message(5)],
    );
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('groupReducer', () => {
  it('tracks who is working and clears it when the run ends', () => {
    let state = groupReducer(initialGroupState, {
      type: 'agentsLoaded',
      agents: [agent('a'), agent('b'), agent('old', 5)],
    });
    state = groupReducer(state, { type: 'running', running: true });
    state = groupReducer(state, { type: 'activity', agentId: 'a', activity: 'working' });
    expect(workingAgents(state).map((a) => a.id)).toEqual(['a']);
    expect(activeAgents(state).map((a) => a.id)).toEqual(['a', 'b']);

    state = groupReducer(state, { type: 'running', running: false });
    expect(workingAgents(state)).toEqual([]);
  });

  it('counts project.md updates and resets', () => {
    const state = groupReducer(initialGroupState, { type: 'projectUpdated' });
    expect(state.projectVersion).toBe(1);
    expect(groupReducer(state, { type: 'reset' })).toEqual(initialGroupState);
  });
});
