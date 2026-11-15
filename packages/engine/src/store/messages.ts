import type { Db } from '../db/database.js';
import type { AuthorKind, Message, MessageMeta } from '../protocol.js';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

interface MessageRow {
  id: number;
  group_id: string;
  author_kind: AuthorKind;
  author_agent_id: string | null;
  body: string;
  meta: string | null;
  thread_id: number | null;
  round: number | null;
  created_at: number;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    groupId: row.group_id,
    authorKind: row.author_kind,
    authorAgentId: row.author_agent_id,
    body: row.body,
    meta: row.meta === null ? null : (JSON.parse(row.meta) as MessageMeta),
    threadId: row.thread_id,
    round: row.round,
    createdAt: row.created_at,
  };
}

export interface NewMessage {
  groupId: string;
  authorKind: AuthorKind;
  authorAgentId?: string | null;
  body: string;
  meta?: MessageMeta | null;
  /** The thread this message belongs to. Human messages start their own thread. */
  threadId?: number | null;
  /** How many hand-offs deep in the thread an agent's reply is. */
  round?: number | null;
}

export function insertMessage(db: Db, input: NewMessage, now: number = Date.now()): Message {
  const row = db
    .prepare(
      `INSERT INTO messages
         (group_id, author_kind, author_agent_id, body, meta, thread_id, round, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.groupId,
      input.authorKind,
      input.authorAgentId ?? null,
      input.body,
      input.meta ? JSON.stringify(input.meta) : null,
      input.threadId ?? null,
      input.round ?? null,
      now,
    ) as MessageRow;
  // Every human message starts a thread, named after the message itself.
  if (row.author_kind === 'human' && row.thread_id === null) {
    db.prepare('UPDATE messages SET thread_id = id WHERE id = ?').run(row.id);
    row.thread_id = row.id;
  }
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

export function getMessage(db: Db, id: number): Message | undefined {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return row ? toMessage(row) : undefined;
}

export function updateMessageMeta(db: Db, id: number, meta: MessageMeta): Message | undefined {
  db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  return getMessage(db, id);
}

/** Whether the human has approved a plan of the lead in this thread. */
export function threadHasApprovedPlan(db: Db, groupId: string, threadId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM messages
       WHERE group_id = ? AND thread_id = ?
         AND json_extract(meta, '$.type') = 'plan'
         AND json_extract(meta, '$.status') = 'approved'
       LIMIT 1`,
    )
    .get(groupId, threadId);
  return row !== undefined;
}

/** Messages after `afterId`, oldest first, with no page limit. For building agent context. */
export function listMessagesSince(db: Db, groupId: string, afterId: number): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE group_id = ? AND id > ? ORDER BY id')
    .all(groupId, afterId) as MessageRow[];
  return rows.map(toMessage);
}
