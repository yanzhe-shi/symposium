import type { Agent, AgentActivity, Message, TeamStatus } from '@symposium/engine/protocol';

export interface GroupState {
  /** Messages sorted by id, with no duplicates. */
  messages: Message[];
  /** Every agent that was ever in the group, fired ones included, so old messages keep names. */
  agents: Agent[];
  activity: Record<string, AgentActivity>;
  /** Per agent, the ids of messages waiting in its inbox for its next turn. */
  queues: Record<string, number[]>;
  running: boolean;
  /** Increases whenever project.md changes, so views can reload it. */
  projectVersion: number;
}

export type GroupAction =
  | { type: 'reset' }
  | { type: 'messagesReceived'; messages: Message[] }
  | { type: 'agentsLoaded'; agents: Agent[] }
  | { type: 'statusLoaded'; status: TeamStatus }
  | { type: 'activity'; agentId: string; activity: AgentActivity }
  | { type: 'queue'; agentId: string; queuedMessageIds: number[] }
  | { type: 'delivered'; agentId: string; messageId: number }
  | { type: 'running'; running: boolean }
  | { type: 'projectUpdated' };

export const initialGroupState: GroupState = {
  messages: [],
  agents: [],
  activity: {},
  queues: {},
  running: false,
  projectVersion: 0,
};

/**
 * Messages can arrive more than once (the POST response and the WebSocket push carry the same
 * message, and a reconnect catch-up overlaps live events) and can change (a diff gets merged).
 * Incoming copies replace the ones we have, matched by id.
 */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  let changed = false;
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(message)) continue;
    byId.set(message.id, message);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function groupReducer(state: GroupState, action: GroupAction): GroupState {
  switch (action.type) {
    case 'reset':
      return initialGroupState;
    case 'messagesReceived': {
      const messages = mergeMessages(state.messages, action.messages);
      return messages === state.messages ? state : { ...state, messages };
    }
    case 'agentsLoaded':
      return { ...state, agents: action.agents };
    case 'statusLoaded': {
      // A fresh snapshot replaces whatever was pieced together from events.
      const { running, agents } = action.status;
      return {
        ...state,
        running,
        activity: Object.fromEntries(agents.map((agent) => [agent.agentId, agent.activity])),
        queues: Object.fromEntries(agents.map((agent) => [agent.agentId, agent.queuedMessageIds])),
      };
    }
    case 'activity':
      return { ...state, activity: { ...state.activity, [action.agentId]: action.activity } };
    case 'queue':
      return { ...state, queues: { ...state.queues, [action.agentId]: action.queuedMessageIds } };
    case 'delivered': {
      const waiting = state.queues[action.agentId] ?? [];
      if (!waiting.includes(action.messageId)) return state;
      const left = waiting.filter((id) => id !== action.messageId);
      return { ...state, queues: { ...state.queues, [action.agentId]: left } };
    }
    case 'running':
      // The scribe tidies up after the team has gone quiet, so its activity is kept.
      return { ...state, running: action.running };
    case 'projectUpdated':
      return { ...state, projectVersion: state.projectVersion + 1 };
  }
}

export function activeAgents(state: GroupState): Agent[] {
  return state.agents.filter((agent) => agent.firedAt === null);
}

export function workingAgents(state: GroupState): Agent[] {
  return state.agents.filter((agent) => state.activity[agent.id] === 'working');
}

/** How many messages are waiting in an agent's inbox. */
export function queuedCount(state: GroupState, agentId: string): number {
  return state.queues[agentId]?.length ?? 0;
}

/** For each waiting message, the names of the agents it is queued for. */
export function queuedFor(state: GroupState): Map<number, string[]> {
  const byMessage = new Map<number, string[]>();
  for (const agent of activeAgents(state)) {
    for (const messageId of state.queues[agent.id] ?? []) {
      byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), agent.name]);
    }
  }
  return byMessage;
}
