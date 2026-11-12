/**
 * What an agent may touch while it works:
 * - `edit`: read and edit files inside `workingDirectory` (a worker's own git worktree)
 * - `read`: read files in `workingDirectory` but change nothing (lead, reviewer)
 * - `none`: no tools at all, text in and text out (scribe)
 *
 * No access level allows running shell commands. That needs human approval, which v1 does not offer.
 */
export type AgentAccess = 'edit' | 'read' | 'none';

/**
 * Whether an agent may run terminal commands, and how the human approves them:
 * - `off`: no commands at all
 * - `ask`: every command waits for the human
 * - `allowlist`: commands matching the agent's allow-list run, the rest wait for the human
 * - `auto`: commands run without asking, inside the agent's own worktree
 *
 * The engine decides each command. Adapters only pass requests on. Until the approval flow
 * exists (milestone 11) every adapter treats all modes as `off`.
 */
export type CommandMode = 'off' | 'ask' | 'allowlist' | 'auto';

/** How hard the model should think. `default` leaves it to the provider. */
export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'default',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/**
 * What an agent did part-way through a turn:
 * - `text`: something it said before its final reply
 * - `read`, `edit`, `search`, `command`: a tool call of that sort. Edits are reported once
 *   they have happened; the others when they start
 * - `tool`: any other tool
 * - `denied`: a tool call the provider's own sandbox refused
 */
export type AgentEventKind = 'text' | 'read' | 'edit' | 'search' | 'command' | 'tool' | 'denied';

export interface AgentEvent {
  kind: AgentEventKind;
  /** The provider's name for the tool, such as `Read` or `write_file`. */
  tool?: string;
  /** What the tool was used on: a path relative to the working directory, a pattern or a command. */
  target?: string;
  /** One line for the activity timeline, such as "read src/cart.ts". */
  summary: string;
}

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
  /** Reasoning effort, for providers that support it. */
  effort?: EffortLevel;
  /** Terminal command mode. See `CommandMode`. */
  commands?: CommandMode;
  /** Called as the agent works, for providers that report progress. Must not throw. */
  onEvent?: (event: AgentEvent) => void;
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

/** A model a provider offers, for the model picker. Any other model name can still be typed in. */
export interface ModelInfo {
  id: string;
  label?: string;
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
