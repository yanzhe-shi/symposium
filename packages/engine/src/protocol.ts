// Types shared between the engine and the UI.
// The UI imports this file with `import type`, so it must contain types only.

export type AuthorKind = 'human' | 'agent' | 'system';

export interface Group {
  id: string;
  name: string;
  /** Project folder. Null only for groups made before milestone 3. */
  folderPath: string | null;
  /** Branch that workers branch from and merges go into. Set when the folder is prepared. */
  baseBranch: string | null;
  /** How many times work may pass between agents in one thread before it waits for the human. */
  maxRounds: number;
  /** How many agents may work at the same time. */
  maxParallel: number;
  /** Whether the lead proposes a plan and waits for approval before assigning work. */
  leadAsksFirst: boolean;
  createdAt: number;
}

export type RoleKind = 'lead' | 'worker' | 'reviewer' | 'scribe';

// Mirrors the adapters package. Re-declared so the UI does not compile Node-only code.
export type ProviderId = 'mock' | 'claude-code' | 'antigravity' | 'openai-compatible';

export interface ProviderOptions {
  command?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  canEditFiles: boolean;
  modelSuggestions: string[];
  smallModel: string;
  description: string;
}

export interface RoleInfo {
  kind: RoleKind;
  title: string;
  summary: string;
}

export interface Agent {
  id: string;
  groupId: string;
  name: string;
  provider: ProviderId;
  model: string;
  role: RoleKind;
  /** Extra job description on top of the built-in role, e.g. "frontend specialist". */
  instructions: string;
  options: ProviderOptions;
  createdAt: number;
  firedAt: number | null;
}

export interface HireRequest {
  name: string;
  provider: ProviderId;
  model: string;
  role: RoleKind;
  instructions?: string;
  options?: ProviderOptions;
}

export type DiffStatus = 'pending' | 'merged' | 'discarded' | 'superseded';
export type ProposalStatus = 'pending' | 'approved' | 'rejected';

/** Structured data attached to a message. The UI renders these specially. */
export type MessageMeta =
  | { type: 'notice'; level: 'info' | 'warning' | 'error' }
  | {
      type: 'hire-proposal';
      status: ProposalStatus;
      proposedBy: string;
      hire: HireRequest;
    }
  | {
      type: 'diff';
      status: DiffStatus;
      agentId: string;
      branch: string;
      baseBranch: string;
      commit: string;
      files: string[];
      stat: string;
      diff: string;
      truncated: boolean;
    };

export interface Message {
  id: number;
  groupId: string;
  authorKind: AuthorKind;
  authorAgentId: string | null;
  body: string;
  meta: MessageMeta | null;
  /** The human message that started this conversation thread. Null for most system messages. */
  threadId: number | null;
  /** For agent replies: how many hand-offs deep in the thread. 0 answers the human directly. */
  round: number | null;
  createdAt: number;
}

export type AgentActivity = 'idle' | 'working';

/** What one agent is doing, and the messages waiting in its inbox. */
export interface AgentStatus {
  agentId: string;
  activity: AgentActivity;
  /** Ids of messages waiting for the agent's next turn, oldest first. */
  queuedMessageIds: number[];
}

/** Snapshot of a group's work, for a UI that just connected. */
export interface TeamStatus {
  /** True while anyone is working or has messages waiting. */
  running: boolean;
  agents: AgentStatus[];
}

/** Events the engine pushes to the UI over the WebSocket, per group. */
export type ServerEvent =
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'agents.changed' }
  | { type: 'group.changed'; group: Group }
  | { type: 'agent.activity'; agentId: string; activity: AgentActivity }
  /** An agent's inbox changed: these messages are waiting for its next turn. */
  | { type: 'agent.queue'; agentId: string; queuedMessageIds: number[] }
  /** A waiting message was handed to the agent, whose turn on it has started. */
  | { type: 'message.delivered'; messageId: number; agentId: string }
  | { type: 'run.status'; running: boolean }
  | { type: 'project.updated' };

export interface CreateMessageRequest {
  body: string;
}

export interface CreateGroupRequest {
  name: string;
  folderPath: string;
}

export interface UpdateGroupRequest {
  name?: string;
  maxRounds?: number;
  maxParallel?: number;
  leadAsksFirst?: boolean;
}

export interface ErrorResponse {
  error: string;
}
