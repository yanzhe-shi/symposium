/**
 * What an agent may touch while it works:
 * - `edit`: read and edit files inside `workingDirectory` (a worker's own git worktree)
 * - `read`: read files in `workingDirectory` but change nothing (lead, reviewer)
 * - `none`: no tools at all, text in and text out (scribe)
 *
 * No access level allows running shell commands. That needs human approval, which v1 does not offer.
 */
export type AgentAccess = 'edit' | 'read' | 'none';

export interface AgentTask {
  agentName: string;
  model: string;
  /** Role, team rules and memory. */
  systemPrompt: string;
  /** Project context, the conversation and the request, ready to send. */
  prompt: string;
  /** The message the agent is responding to. Used by the mock adapter and for logs. */
  trigger: string;
  workingDirectory: string;
  access: AgentAccess;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AgentReply {
  text: string;
  /** Paths (relative to the working directory) that changed during the turn. */
  changedFiles: string[];
  costUsd?: number;
  /** Something odd the provider reported that did not stop the turn. Shown in the chat. */
  warning?: string;
}

/** Every agent provider is reached through one of these. The engine never calls a provider itself. */
export interface AgentAdapter {
  readonly provider: ProviderId;
  run(task: AgentTask): Promise<AgentReply>;
}

export type ProviderId = 'mock' | 'claude-code' | 'antigravity' | 'openai-compatible';

/** Per-agent provider settings, stored with the agent. Never holds secrets. */
export interface ProviderOptions {
  /** Path or name of the CLI binary, for the CLI providers. */
  command?: string;
  /** Base URL for the OpenAI-compatible provider, e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl?: string;
  /** Name of the environment variable that holds the API key. The key itself is never stored. */
  apiKeyEnv?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Whether agents on this provider can edit files in their worktree. */
  canEditFiles: boolean;
  modelSuggestions: string[];
  /** A small, cheap model for the scribe. */
  smallModel: string;
  description: string;
}

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class AdapterError extends Error {
  constructor(
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
