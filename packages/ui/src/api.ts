import type {
  Agent,
  AgentProgress,
  CreateGroupRequest,
  ErrorResponse,
  FileContent,
  FolderChoices,
  FolderListing,
  Group,
  HireRequest,
  Message,
  ModelList,
  OpenInEditorRequest,
  ProjectsFolder,
  ProviderId,
  ProviderOptions,
  ProviderInfo,
  RoleInfo,
  ServerEvent,
  TeamStatus,
  TerminalRun,
  UpdateAgentRequest,
  UpdateGroupRequest,
  WorktreeChanges,
} from '@symposium/engine/protocol';

export const MAX_PAGE_SIZE = 500;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const details = (await res.json().catch(() => null)) as ErrorResponse | null;
    throw new Error(details?.error ?? `Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const groupUrl = (groupId: string) => `/api/groups/${encodeURIComponent(groupId)}`;

/** Where the Code tab looks: the project folder, or the worktree of the agent with this id. */
export type CodeLocation = 'project' | (string & {});

export const api = {
  groups: () => request<Group[]>('/api/groups'),
  createGroup: (input: CreateGroupRequest) => send<Group>('POST', '/api/groups', input),
  updateGroup: (groupId: string, changes: UpdateGroupRequest) =>
    send<Group>('PATCH', groupUrl(groupId), changes),

  /** Deletes the group's chat, team and worktrees for good. The project folder stays. */
  deleteGroup: (groupId: string) => send<{ deleted: boolean }>('DELETE', groupUrl(groupId)),
  /** Where new projects go unless another folder is picked. */
  projectsFolder: () => request<ProjectsFolder>('/api/fs/projects'),
  /** The folders inside a folder, for the folder picker. Without a path: where projects go. */
  folderChoices: (path?: string) =>
    request<FolderChoices>(`/api/fs/dirs?${new URLSearchParams(path ? { path } : {})}`),
  /** Opens the group's workspace, a folder or a file in VS Code on this machine. */
  openInEditor: (groupId: string, target: OpenInEditorRequest = {}) =>
    send<{ opened: string }>('POST', `${groupUrl(groupId)}/open`, target),

  providers: () => request<ProviderInfo[]>('/api/providers'),
  /** The models a provider offers right now, asked with the agent's own provider options. */
  models: (providerId: ProviderId, options: ProviderOptions = {}) => {
    const query = new URLSearchParams(
      Object.entries(options).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    return request<ModelList>(`/api/providers/${providerId}/models?${query.toString()}`);
  },
  roles: () => request<RoleInfo[]>('/api/roles'),

  agents: (groupId: string) => request<Agent[]>(`${groupUrl(groupId)}/agents?includeFired=true`),
  hire: (groupId: string, hire: HireRequest) =>
    send<Agent>('POST', `${groupUrl(groupId)}/agents`, hire),
  editAgent: (groupId: string, agentId: string, changes: UpdateAgentRequest) =>
    send<Agent>('PATCH', `${groupUrl(groupId)}/agents/${agentId}`, changes),
  fire: (groupId: string, agentId: string) =>
    send<Agent>('DELETE', `${groupUrl(groupId)}/agents/${agentId}`),

  messages: (groupId: string, limit = MAX_PAGE_SIZE) =>
    request<Message[]>(`${groupUrl(groupId)}/messages?limit=${limit}`),
  post: (groupId: string, body: string) =>
    send<Message>('POST', `${groupUrl(groupId)}/messages`, { body }),
  decide: (
    groupId: string,
    messageId: number,
    decision:
      | 'approve-hire'
      | 'reject-hire'
      | 'merge'
      | 'discard'
      | 'allow-command'
      | 'always-allow-command'
      | 'deny-command',
  ) => send<Message>('POST', `${groupUrl(groupId)}/messages/${messageId}/${decision}`),

  runStatus: (groupId: string) => request<TeamStatus>(`${groupUrl(groupId)}/run`),
  stopAll: (groupId: string) => send<{ stopped: boolean }>('POST', `${groupUrl(groupId)}/stop`),
  stopAgent: (groupId: string, agentId: string) =>
    send<{ stopped: boolean }>('POST', `${groupUrl(groupId)}/agents/${agentId}/stop`),

  /** The team's recent tool calls, oldest first. */
  activity: (groupId: string) => request<AgentProgress[]>(`${groupUrl(groupId)}/activity`),
  /** An agent's uncommitted work in its worktree. */
  changes: (groupId: string, agentId: string) =>
    request<WorktreeChanges>(
      `${groupUrl(groupId)}/changes?${new URLSearchParams({ where: agentId })}`,
    ),
  files: (groupId: string, where: CodeLocation, path: string) =>
    request<FolderListing>(`${groupUrl(groupId)}/files?${new URLSearchParams({ where, path })}`),
  file: (groupId: string, where: CodeLocation, path: string) =>
    request<FileContent>(`${groupUrl(groupId)}/file?${new URLSearchParams({ where, path })}`),

  /** Runs a command of your own in the project folder or a worktree. Output comes as events. */
  runCommand: (groupId: string, where: CodeLocation, command: string) =>
    send<TerminalRun>('POST', `${groupUrl(groupId)}/terminal`, { where, command }),
  stopCommand: (groupId: string, runId: string) =>
    send<{ stopped: boolean }>('POST', `${groupUrl(groupId)}/terminal/${runId}/stop`),

  project: (groupId: string) => request<{ content: string }>(`${groupUrl(groupId)}/project`),
  saveProject: (groupId: string, content: string) =>
    send<{ content: string }>('PUT', `${groupUrl(groupId)}/project`, { content }),
  memory: (groupId: string, agentId: string) =>
    request<{ content: string }>(`${groupUrl(groupId)}/agents/${agentId}/memory`),
  saveMemory: (groupId: string, agentId: string, content: string) =>
    send<{ content: string }>('PUT', `${groupUrl(groupId)}/agents/${agentId}/memory`, {
      content,
    }),
};

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface GroupConnectionHandlers {
  onEvent: (event: ServerEvent) => void;
  /** Called on every successful (re)connect, so the caller can catch up on missed changes. */
  onOpen: () => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/** Opens the group's WebSocket and reconnects with exponential backoff. Returns a stop function. */
export function connectGroup(groupId: string, handlers: GroupConnectionHandlers): () => void {
  let socket: WebSocket | undefined;
  let retryMs = MIN_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function open(): void {
    handlers.onStatusChange('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(
      `${protocol}//${location.host}/ws?groupId=${encodeURIComponent(groupId)}`,
    );
    socket.addEventListener('open', () => {
      retryMs = MIN_RETRY_MS;
      handlers.onStatusChange('open');
      handlers.onOpen();
    });
    socket.addEventListener('message', (event) => {
      handlers.onEvent(JSON.parse(String(event.data)) as ServerEvent);
    });
    socket.addEventListener('close', () => {
      if (stopped) return;
      handlers.onStatusChange('closed');
      retryTimer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    });
  }

  open();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    socket?.close();
  };
}
