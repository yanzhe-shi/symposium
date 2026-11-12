import type {
  Agent,
  CreateGroupRequest,
  ErrorResponse,
  Group,
  HireRequest,
  Message,
  ModelList,
  ProviderId,
  ProviderOptions,
  ProviderInfo,
  RoleInfo,
  ServerEvent,
  TeamStatus,
  UpdateAgentRequest,
  UpdateGroupRequest,
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

export const api = {
  groups: () => request<Group[]>('/api/groups'),
  createGroup: (input: CreateGroupRequest) => send<Group>('POST', '/api/groups', input),
  updateGroup: (groupId: string, changes: UpdateGroupRequest) =>
    send<Group>('PATCH', groupUrl(groupId), changes),

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
    decision: 'approve-hire' | 'reject-hire' | 'merge' | 'discard',
  ) => send<Message>('POST', `${groupUrl(groupId)}/messages/${messageId}/${decision}`),

  runStatus: (groupId: string) => request<TeamStatus>(`${groupUrl(groupId)}/run`),
  stopAll: (groupId: string) => send<{ stopped: boolean }>('POST', `${groupUrl(groupId)}/stop`),
  stopAgent: (groupId: string, agentId: string) =>
    send<{ stopped: boolean }>('POST', `${groupUrl(groupId)}/agents/${agentId}/stop`),

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
