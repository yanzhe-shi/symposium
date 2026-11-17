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
  /**
   * Whether the lead's plan needs the human's approval before work starts. The engine enforces
   * it: the lead's hand-offs are held until the human approves, once per thread.
   */
  leadAsksFirst: boolean;
  /**
   * A command the engine runs in a worker's worktree after each of its changes, such as
   * `npm test`. Its result goes on the diff. Empty: no check.
   */
  checkCommand: string;
  /**
   * Whether the engine has a reviewer look at every worker's change before anyone acts on it.
   * Needs a reviewer on the team.
   */
  autoReview: boolean;
  /**
   * Whether agents' processes run in a sandbox: they can change only their own folder, and the
   * places for keys and logins are hidden from them. Works where the computer allows it.
   */
  sandbox: boolean;
  /** More folders a sandboxed agent may write to, such as a build cache. Full paths. */
  sandboxFolders: string[];
  /**
   * TCP ports on this computer that a sandboxed agent may reach, such as a database its tests
   * need. Every other program on this computer is out of its reach, where the computer can
   * give the sandbox a network of its own. Symposium's own port is never among them.
   */
  sandboxPorts: number[];
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

// These three mirror the adapters package too.
export type FileAccess = 'none' | 'read' | 'edit';
export type CommandMode = 'off' | 'ask' | 'allowlist' | 'auto';
export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * What one agent may do and how hard it thinks. Defaults come from the role; the human can
 * change them for each agent. The engine enforces them, never the model.
 */
export interface AgentSettings {
  /** `edit` gives the agent its own branch and worktree. `read` shows it the project folder. */
  files: FileAccess;
  /**
   * Terminal commands: `off`, `ask` (you approve each one), `allowlist` (listed commands run,
   * you approve the rest) or `auto` (commands run). Some commands always ask.
   */
  commands: CommandMode;
  /** Command patterns that run without asking when `commands` is `allowlist`. */
  allowlist: string[];
  effort: EffortLevel;
}

export interface ModelInfo {
  id: string;
  label?: string;
}

/** Answer of `GET /api/providers/:id/models`. */
export interface ModelList {
  models: ModelInfo[];
  /** Set when the provider could not be asked; `models` then holds the built-in suggestions. */
  error?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  canEditFiles: boolean;
  canRunCommands: boolean;
  modelSuggestions: string[];
  smallModel: string;
  description: string;
}

/** A role as someone writes it: what the human types in the role editor, or a lead proposes. */
export interface RoleDraft {
  /** The role's name, such as "Designer". */
  title: string;
  /** How the engine treats agents in this role. */
  kind: RoleKind;
  /** One line for the hire form. */
  summary: string;
  /** The job description, in Markdown. It becomes part of the agent's instructions. */
  text: string;
}

export interface RoleInfo extends RoleDraft {
  /** What a hire refers to. A built-in role's id is its kind. */
  id: string;
  /** One of the four roles Symposium comes with. */
  builtIn: boolean;
  /** A built-in role whose job description the human has changed. */
  edited: boolean;
  /** The file access agents in this role get unless the human chooses otherwise. */
  defaultFiles: FileAccess;
  /** The command mode agents in this role get unless the human chooses otherwise. */
  defaultCommands: CommandMode;
}

export interface Agent {
  id: string;
  groupId: string;
  name: string;
  provider: ProviderId;
  model: string;
  /** How the engine treats the agent. It comes from the agent's role. */
  role: RoleKind;
  /** The role the agent was hired into: a built-in role's kind, or a custom role's id. */
  roleId: string;
  /** Extra job description on top of the role, e.g. "frontend specialist". */
  instructions: string;
  options: ProviderOptions;
  /** The settings in force: the role's defaults with the human's choices on top. */
  settings: AgentSettings;
  createdAt: number;
  firedAt: number | null;
}

export interface HireRequest {
  name: string;
  provider: ProviderId;
  model: string;
  /**
   * The role to hire into: a built-in kind, or the id or name of a custom role. The engine
   * replaces it with the role's kind.
   */
  role: RoleKind;
  /** The id of the role. When set it wins over `role`. */
  roleId?: string;
  instructions?: string;
  options?: ProviderOptions;
  /** Only the settings that should differ from the role's defaults need to be given. */
  settings?: Partial<AgentSettings>;
}

/** Changes to an agent on the team. The name stays: branches and mentions depend on it. */
export type UpdateAgentRequest = Partial<Omit<HireRequest, 'name'>>;

/** One member of a saved team, as the lists show it. */
export interface SavedTeamMember {
  name: string;
  provider: ProviderId;
  model: string;
  role: RoleKind;
  roleId: string;
  /** Whether what this agent remembers was saved with the team. */
  hasMemory: boolean;
}

/**
 * A team the human saved to hire again in another group: who is on it, and how each one is set
 * up. Kept as one file per team in Symposium's data folder.
 */
export interface SavedTeam {
  id: string;
  name: string;
  savedAt: number;
  members: SavedTeamMember[];
}

/** Body of `POST /api/groups/:id/save-team`: saves the group's current team under a name. */
export interface SaveTeamRequest {
  name: string;
  /** Also save what each agent remembers. Off unless asked for. */
  withMemory?: boolean;
  /** Write over a saved team of the same name. Without it that is a conflict. */
  replace?: boolean;
}

/** Body of `POST /api/groups/:id/hire-team`. */
export interface HireTeamRequest {
  teamId: string;
}

/** Answer of `POST /api/groups/:id/hire-team`. */
export interface HireTeamResult {
  hired: Agent[];
  /** Members that could not be hired, each with the reason: "Lea: Lea is already on the team". */
  skipped: string[];
}

/**
 * Body of `POST /api/groups/:id/agents/:agentId/send`: hires a copy of the agent into another
 * group. The agent stays in this group too unless `leave` is set.
 */
export interface SendAgentRequest {
  toGroupId: string;
  /** Take what the agent remembers along. On unless switched off. */
  withMemory?: boolean;
  /** Fire the agent here once it has arrived there. */
  leave?: boolean;
  /** Another name in the other group, when theirs is taken there. */
  name?: string;
}

export type DiffStatus = 'pending' | 'merged' | 'discarded' | 'superseded';
/**
 * What became of a command an agent asked to run. `expired`: nobody answered in time.
 * `cancelled`: the agent was stopped, or the engine restarted, while it waited.
 */
export type CommandStatus = 'pending' | 'allowed' | 'denied' | 'expired' | 'cancelled';
/**
 * How the group's check command went on a worker's change. `timed-out`: it ran too long.
 * `stopped`: the human stopped the agent while it ran. `error`: it could not be started.
 */
export type CheckStatus = 'running' | 'passed' | 'failed' | 'timed-out' | 'stopped' | 'error';

export interface CheckResult {
  command: string;
  status: CheckStatus;
  /** Null unless the command ran to its end. */
  exitCode: number | null;
  /** The end of what the command printed. */
  output: string;
  durationMs: number;
}

/**
 * How a reviewer judged a worker's change. `changes`: something must be fixed first.
 * `unclear`: the reviewer answered without a verdict. `failed`: its turn did not finish.
 */
export type ReviewStatus = 'running' | 'approved' | 'changes' | 'unclear' | 'failed' | 'stopped';

export interface ReviewResult {
  reviewerId: string;
  status: ReviewStatus;
  /** The reviewer's message with the review, once there is one. */
  messageId?: number;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export type PlanStatus = 'pending' | 'approved' | 'declined';

/** Structured data attached to a message. The UI renders these specially. */
export type MessageMeta =
  | { type: 'notice'; level: 'info' | 'warning' | 'error' }
  | {
      type: 'hire-proposal';
      status: ProposalStatus;
      proposedBy: string;
      hire: HireRequest;
      /** A role the lead wrote for this hire. Approving the hire adds the role too. */
      newRole?: RoleDraft;
    }
  | {
      /**
       * The lead wants to hand out work and the engine holds its message back until the human
       * approves. The card's `threadId` and `round` are those of the held message.
       */
      type: 'plan';
      status: PlanStatus;
      leadId: string;
      /** The lead's message that waits. */
      replyMessageId: number;
      /** The teammates that message hands work to. */
      recipientIds: string[];
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
      /** How the group's check command went on this change. Absent: no check was set. */
      check?: CheckResult;
      /** The engine-run review of this change. Absent: none was asked for. */
      review?: ReviewResult;
    }
  | {
      /** An agent wants to run a terminal command and waits for the human. */
      type: 'command';
      status: CommandStatus;
      agentId: string;
      command: string;
      /** Where it would run, in words: "Ada's worktree (symposium/ada)". */
      folder: string;
      /** Why the human is asked. */
      reason: string;
      /** The patterns "Always allow" would add to the agent's allow-list. Empty: not offered. */
      patterns: string[];
      /** Set when the human chose "Always allow". */
      always?: boolean;
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

/** Mirrors the adapters package: what an agent did part-way through a turn. */
export type AgentEventKind =
  'text' | 'read' | 'edit' | 'search' | 'command' | 'tool' | 'denied' | 'output';

export interface AgentEvent {
  kind: AgentEventKind;
  /** The provider's name for the tool, such as `Read` or `write_file`. */
  tool?: string;
  /** What the tool was used on: a path relative to the agent's folder, a pattern or a command. */
  target?: string;
  /** One line for the activity timeline, such as "read src/cart.ts". */
  summary: string;
  /** For `output`: the end of what a command printed. */
  output?: string;
  /** For `output`: the command's exit code, when known. */
  exitCode?: number;
}

/** One entry in an agent's activity timeline. */
export interface AgentProgress {
  agentId: string;
  /** When it happened, in milliseconds. */
  at: number;
  event: AgentEvent;
}

/** A worktree's uncommitted work: what an agent has changed so far in the turn it is on. */
export interface WorktreeChanges {
  files: string[];
  diff: string;
  truncated: boolean;
}

/** One entry of a folder listing in the Code tab. */
export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  /** Bytes, for files. */
  size: number;
}

/** Answer of `GET /api/groups/:id/files`. */
export interface FolderListing {
  /** Path inside the project folder or worktree, with `/` separators. Empty for the top. */
  path: string;
  entries: FileEntry[];
  /** True when the folder has more entries than are listed. */
  truncated: boolean;
}

/** Answer of `GET /api/groups/:id/file`. */
export interface FileContent {
  path: string;
  size: number;
  /** Null when the file is not shown. `skipped` says why. */
  content: string | null;
  skipped?: 'binary' | 'too-large';
}

/** What some work took: one agent's, one task's or the whole group's. */
export interface UsageTotals {
  /** Turns started, the failed ones included. */
  turns: number;
  failedTurns: number;
  /** Time agents spent on those turns. */
  durationMs: number;
  /** The sum of what providers reported for those turns. Null when none of them reported a cost. */
  costUsd: number | null;
  /** How many of the turns came with a cost. */
  pricedTurns: number;
}

export interface AgentUsage extends UsageTotals {
  agentId: string;
}

/** A task: one message of the human and everything the team did because of it. */
export interface ThreadUsage extends UsageTotals {
  threadId: number;
  /** The first line of the human's message. */
  title: string;
  agentIds: string[];
}

/** Answer of `GET /api/groups/:id/usage`. */
export interface GroupUsage {
  total: UsageTotals;
  agents: AgentUsage[];
  /** Newest first. */
  threads: ThreadUsage[];
}

/** Events the engine pushes to the UI over the WebSocket, per group. */
export type ServerEvent =
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'agents.changed' }
  | { type: 'group.changed'; group: Group }
  /** The human deleted the group. Nothing more will come. */
  | { type: 'group.deleted' }
  | { type: 'agent.activity'; agentId: string; activity: AgentActivity }
  /** An agent's inbox changed: these messages are waiting for its next turn. */
  | { type: 'agent.queue'; agentId: string; queuedMessageIds: number[] }
  /** A waiting message was handed to the agent, whose turn on it has started. */
  | { type: 'message.delivered'; messageId: number; agentId: string }
  | { type: 'run.status'; running: boolean }
  /** Something an agent did during its turn: a tool call, or something it said along the way. */
  | { type: 'agent.progress'; progress: AgentProgress }
  /** An agent's uncommitted work changed. Empty once its turn's work is committed. */
  | { type: 'worktree.changed'; agentId: string; changes: WorktreeChanges }
  /** Output of a command the human runs from the Code tab. */
  | { type: 'terminal.output'; runId: string; text: string }
  /** That command ended. `exitCode` is null when it was stopped or could not start. */
  | { type: 'terminal.exit'; runId: string; exitCode: number | null }
  | { type: 'project.updated' };

/** Answer of `GET /api/system`: what is installed on this machine. */
export interface SystemInfo {
  git: boolean;
  /** Whether the `code` command is on PATH, for Open in VS Code. */
  vscode: boolean;
  /** Per provider, whether its program was found. API and mock providers need none. */
  providers: Record<ProviderId, boolean>;
  /**
   * Whether this computer can sandbox agents at all (Linux with bubblewrap), the providers
   * whose agents still run without one because something more is missing, and whether the
   * sandbox gets a network of its own (pasta), which keeps agents from programs on this computer.
   */
  sandbox: { works: boolean; without: ProviderId[]; network: boolean };
}

/** Body of `POST /api/groups/:id/terminal`: a command the human runs themselves. */
export interface RunCommandRequest {
  /** `project`, or the id of an agent whose worktree to run in. */
  where: string;
  command: string;
}

/** A command the human started from the Code tab. */
export interface TerminalRun {
  runId: string;
  where: string;
  /** Where it runs, in words. */
  folder: string;
  command: string;
}

/** Answer of `GET /api/fs/projects`: where new projects go unless another folder is picked. */
export interface ProjectsFolder {
  path: string;
}

/** Answer of `GET /api/fs/dirs`: the folders inside one folder, for the folder picker. */
export interface FolderChoices {
  path: string;
  /** Null at the top of the file system. */
  parent: string | null;
  dirs: string[];
  truncated: boolean;
}

/**
 * Body of `POST /api/groups/:id/open`. Empty: the group's VS Code workspace. `where` alone: the
 * project folder (`project`) or an agent's worktree. With `path`: one file in that folder.
 */
export interface OpenInEditorRequest {
  where?: string;
  path?: string;
}

export interface CreateMessageRequest {
  body: string;
}

export interface CreateGroupRequest {
  name: string;
  folderPath: string;
  /**
   * Hire a starter team on this provider right away: a lead, a worker, a reviewer and a
   * scribe. Left out, the group starts empty.
   */
  starterTeam?: ProviderId;
  /** Hire this saved team right away, by its id. Not together with `starterTeam`. */
  team?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  maxRounds?: number;
  maxParallel?: number;
  leadAsksFirst?: boolean;
  checkCommand?: string;
  autoReview?: boolean;
  sandbox?: boolean;
  sandboxFolders?: string[];
  sandboxPorts?: number[];
}

export interface ErrorResponse {
  error: string;
}
