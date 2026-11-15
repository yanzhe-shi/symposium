import type { Sandbox } from './sandbox.js';

/**
 * What an agent may touch while it works:
 * - `edit`: read and edit files inside `workingDirectory` (a worker's own git worktree)
 * - `read`: read files in `workingDirectory` but change nothing (lead, reviewer)
 * - `none`: no file tools at all (scribe)
 *
 * File access says nothing about terminal commands. Those are a separate setting: `CommandMode`.
 */
export type AgentAccess = 'edit' | 'read' | 'none';

/**
 * Whether an agent may run terminal commands, and how the human approves them:
 * - `off`: no commands at all
 * - `ask`: every command waits for the human
 * - `allowlist`: commands matching the agent's allow-list run, the rest wait for the human
 * - `auto`: commands run without asking, inside the agent's own worktree
 *
 * The engine decides each command. An adapter only passes each request on through
 * `AgentTask.onCommand` and does what the answer says. A provider that cannot ask before it
 * runs a command treats every mode as `off`.
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
 * - `denied`: a tool call that was refused, by the provider's own sandbox or by Symposium
 * - `output`: how a command ended, with what it printed
 */
export type AgentEventKind =
  'text' | 'read' | 'edit' | 'search' | 'command' | 'tool' | 'denied' | 'output';

export interface AgentEvent {
  kind: AgentEventKind;
  /** The provider's name for the tool, such as `Read` or `write_file`. */
  tool?: string;
  /** What the tool was used on: a path relative to the working directory, a pattern or a command. */
  target?: string;
  /** One line for the activity timeline, such as "read src/cart.ts". */
  summary: string;
  /** For `output`: the end of what the command printed. */
  output?: string;
  /** For `output`: the command's exit code, when the provider reports one. */
  exitCode?: number;
}

/** A terminal command an agent wants to run in its working directory. */
export interface CommandRequest {
  command: string;
  /** What the agent says the command is for, when the provider passes that on. */
  description?: string;
}

export interface CommandDecision {
  allow: boolean;
  /** Told to the agent when the command is refused. */
  reason?: string;
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
  /**
   * Asked before every terminal command, when `commands` is not `off`. The command runs only
   * if the answer allows it. The answer may take minutes: a human may be deciding. Without
   * this, no adapter offers commands at all.
   */
  onCommand?: (request: CommandRequest) => Promise<CommandDecision>;
  /** Called as the agent works, for providers that report progress. Must not throw. */
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * What the provider's process may touch, for providers that run a program on this computer.
   * The engine decides it. Without it the process runs as the user does.
   */
  sandbox?: Sandbox;
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
  /** Whether the provider can ask before it runs a terminal command. Without that, no terminal. */
  canRunCommands: boolean;
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
