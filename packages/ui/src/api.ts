import type { ErrorResponse, Group, Message, ServerEvent } from '@symposium/engine/protocol';

export const MAX_PAGE_SIZE = 500;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const details = (await res.json().catch(() => null)) as ErrorResponse | null;
    throw new Error(details?.error ?? `Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchGroups(): Promise<Group[]> {
  return request<Group[]>('/api/groups');
}

export function fetchMessages(
  groupId: string,
  options: { afterId?: number; limit?: number } = {},
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (options.afterId !== undefined) params.set('afterId', String(options.afterId));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.size > 0 ? `?${params}` : '';
  return request<Message[]>(`/api/groups/${encodeURIComponent(groupId)}/messages${query}`);
}

export function postMessage(groupId: string, body: string): Promise<Message> {
  return request<Message>(`/api/groups/${encodeURIComponent(groupId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface ChatConnectionHandlers {
  onEvent: (event: ServerEvent) => void;
  /** Called on every successful (re)connect, so the caller can catch up on missed messages. */
  onOpen: () => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/** Opens the group's WebSocket and reconnects with exponential backoff. Returns a stop function. */
export function connectChat(groupId: string, handlers: ChatConnectionHandlers): () => void {
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
