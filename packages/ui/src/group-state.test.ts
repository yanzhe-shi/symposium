import type { Agent, Message } from '@symposium/engine/protocol';
import { agentStatusLabel } from './components/TeamPanel.tsx';
import { describe, expect, it } from 'vitest';
import {
  activeAgents,
  groupReducer,
  initialGroupState,
  mergeMessages,
  queuedCount,
  queuedFor,
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
    threadId: id,
    round: null,
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
  const team = { type: 'agentsLoaded' as const, agents: [agent('a'), agent('b'), agent('old', 5)] };

  it('tracks several agents working at once, each until its own turn ends', () => {
    let state = groupReducer(initialGroupState, team);
    state = groupReducer(state, { type: 'running', running: true });
    state = groupReducer(state, { type: 'activity', agentId: 'a', activity: 'working' });
    state = groupReducer(state, { type: 'activity', agentId: 'b', activity: 'working' });
    expect(workingAgents(state).map((a) => a.id)).toEqual(['a', 'b']);
    expect(activeAgents(state).map((a) => a.id)).toEqual(['a', 'b']);

    state = groupReducer(state, { type: 'activity', agentId: 'a', activity: 'idle' });
    expect(workingAgents(state).map((a) => a.id)).toEqual(['b']);
  });

  it('shows a message as queued for a busy agent until it is delivered', () => {
    let state = groupReducer(initialGroupState, team);
    state = groupReducer(state, { type: 'queue', agentId: 'a', queuedMessageIds: [7, 9] });
    state = groupReducer(state, { type: 'queue', agentId: 'b', queuedMessageIds: [9] });
    expect(queuedCount(state, 'a')).toBe(2);
    expect(queuedFor(state)).toEqual(
      new Map([
        [7, ['a']],
        [9, ['a', 'b']],
      ]),
    );

    state = groupReducer(state, { type: 'delivered', agentId: 'a', messageId: 9 });
    expect(queuedFor(state)).toEqual(
      new Map([
        [7, ['a']],
        [9, ['b']],
      ]),
    );
    // A repeat, or a delivery we never saw queued, changes nothing.
    expect(groupReducer(state, { type: 'delivered', agentId: 'a', messageId: 9 })).toBe(state);

    state = groupReducer(state, { type: 'queue', agentId: 'a', queuedMessageIds: [] });
    state = groupReducer(state, { type: 'delivered', agentId: 'b', messageId: 9 });
    expect(queuedFor(state).size).toBe(0);
    expect(queuedCount(state, 'a')).toBe(0);
  });

  it('replaces activity and queues with a fresh snapshot after a reconnect', () => {
    let state = groupReducer(initialGroupState, team);
    state = groupReducer(state, { type: 'activity', agentId: 'a', activity: 'working' });
    state = groupReducer(state, { type: 'queue', agentId: 'a', queuedMessageIds: [3] });
    state = groupReducer(state, {
      type: 'statusLoaded',
      status: {
        running: true,
        agents: [
          { agentId: 'a', activity: 'idle', queuedMessageIds: [] },
          { agentId: 'b', activity: 'working', queuedMessageIds: [4] },
        ],
      },
    });
    expect(state.running).toBe(true);
    expect(workingAgents(state).map((a) => a.id)).toEqual(['b']);
    expect(queuedFor(state)).toEqual(new Map([[4, ['b']]]));
  });

  it('labels an agent card by what the agent is doing', () => {
    expect(agentStatusLabel(false, 0)).toBe('Idle');
    expect(agentStatusLabel(true, 0)).toBe('Working');
    expect(agentStatusLabel(true, 2)).toBe('Working · 2 queued');
    // Waiting for a free slot under the group's cap.
    expect(agentStatusLabel(false, 1)).toBe('1 queued');
  });

  it('counts project.md updates and resets', () => {
    const state = groupReducer(initialGroupState, { type: 'projectUpdated' });
    expect(state.projectVersion).toBe(1);
    expect(groupReducer(state, { type: 'reset' })).toEqual(initialGroupState);
  });
});
