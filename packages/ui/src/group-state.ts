import type { Agent, AgentActivity, Message } from '@symposium/engine/protocol';

export interface GroupState {
  /** Messages sorted by id, with no duplicates. */
  messages: Message[];
  /** Every agent that was ever in the group, fired ones included, so old messages keep names. */
  agents: Agent[];
  activity: Record<string, AgentActivity>;
  running: boolean;
  /** Increases whenever project.md changes, so views can reload it. */
  projectVersion: number;
}

export type GroupAction =
  | { type: 'reset' }
  | { type: 'messagesReceived'; messages: Message[] }
  | { type: 'agentsLoaded'; agents: Agent[] }
  | { type: 'activity'; agentId: string; activity: AgentActivity }
  | { type: 'running'; running: boolean }
  | { type: 'projectUpdated' };

export const initialGroupState: GroupState = {
  messages: [],
  agents: [],
  activity: {},
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
    case 'activity':
      return { ...state, activity: { ...state.activity, [action.agentId]: action.activity } };
    case 'running':
      // When a run ends, nobody is working any more.
      return { ...state, running: action.running, activity: action.running ? state.activity : {} };
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
