import type { Db } from '../db/database.js';

export interface EventRecord {
  id: number;
  groupId: string;
  agentId: string | null;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

/** Appends to the audit log. Every hire, fire, agent turn and git operation is recorded. */
export function logEvent(
  db: Db,
  input: {
    groupId: string;
    agentId?: string | null;
    kind: string;
    detail?: Record<string, unknown>;
  },
  now: number = Date.now(),
): void {
  db.prepare(
    'INSERT INTO events (group_id, agent_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(input.groupId, input.agentId ?? null, input.kind, JSON.stringify(input.detail ?? {}), now);
}

export function listEvents(db: Db, groupId: string): EventRecord[] {
  const rows = db.prepare('SELECT * FROM events WHERE group_id = ? ORDER BY id').all(groupId) as {
    id: number;
    group_id: string;
    agent_id: string | null;
    kind: string;
    detail: string;
    created_at: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    agentId: row.agent_id,
    kind: row.kind,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}
