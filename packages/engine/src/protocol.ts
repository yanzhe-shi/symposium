// Types shared between the engine and the UI.
// The UI imports this file with `import type`, so it must contain types only.

export type AuthorKind = 'human' | 'agent' | 'system';

export interface Group {
  id: string;
  name: string;
  folderPath: string | null;
  createdAt: number;
}

export interface Message {
  id: number;
  groupId: string;
  authorKind: AuthorKind;
  authorAgentId: string | null;
  body: string;
  createdAt: number;
}

/** Events the engine pushes to the UI over the WebSocket. */
export type ServerEvent = { type: 'message.created'; message: Message };

export interface CreateMessageRequest {
  body: string;
}

export interface ErrorResponse {
  error: string;
}
