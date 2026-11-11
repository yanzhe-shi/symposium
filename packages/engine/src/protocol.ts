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
  /** How many times work may pass between agents before the team waits for the human. */
  maxRounds: number;
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
  createdAt: number;
}

export type AgentActivity = 'idle' | 'working';

/** Events the engine pushes to the UI over the WebSocket, per group. */
export type ServerEvent =
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'agents.changed' }
  | { type: 'group.changed'; group: Group }
  | { type: 'agent.activity'; agentId: string; activity: AgentActivity }
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
}

export interface ErrorResponse {
  error: string;
}
