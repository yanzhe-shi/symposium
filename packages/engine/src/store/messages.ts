import type { Db } from '../db/database.js';
import type { AuthorKind, Message } from '../protocol.js';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

interface MessageRow {
  id: number;
  group_id: string;
  author_kind: AuthorKind;
  author_agent_id: string | null;
  body: string;
  created_at: number;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    groupId: row.group_id,
    authorKind: row.author_kind,
    authorAgentId: row.author_agent_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

export interface NewMessage {
  groupId: string;
  authorKind: AuthorKind;
  authorAgentId?: string | null;
  body: string;
}

export function insertMessage(db: Db, input: NewMessage, now: number = Date.now()): Message {
  const row = db
    .prepare(
      `INSERT INTO messages (group_id, author_kind, author_agent_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.groupId,
      input.authorKind,
      input.authorAgentId ?? null,
      input.body,
      now,
    ) as MessageRow;
  return toMessage(row);
}

export interface ListMessagesOptions {
  /** Only return messages with an id greater than this. */
  afterId?: number;
  limit?: number;
}

/**
 * Returns messages in a group, oldest first.
 * Without `afterId` it returns the most recent `limit` messages (what a chat shows on open).
 * With `afterId` it returns up to `limit` messages after that id (catching up after a reconnect).
 */
export function listMessages(
  db: Db,
  groupId: string,
  options: ListMessagesOptions = {},
): Message[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  if (options.afterId !== undefined) {
    const rows = db
      .prepare('SELECT * FROM messages WHERE group_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(groupId, options.afterId, limit) as MessageRow[];
    return rows.map(toMessage);
  }
  const rows = db
    .prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY id DESC LIMIT ?')
    .all(groupId, limit) as MessageRow[];
  return rows.reverse().map(toMessage);
}
