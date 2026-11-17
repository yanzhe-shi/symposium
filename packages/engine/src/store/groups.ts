import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { Group } from '../protocol.js';

export const DEFAULT_MAX_ROUNDS = 6;
export const DEFAULT_MAX_PARALLEL = 3;

interface GroupRow {
  id: string;
  name: string;
  folder_path: string | null;
  base_branch: string | null;
  max_rounds: number;
  max_parallel: number;
  lead_asks_first: number;
  check_command: string;
  auto_review: number;
  sandbox: number;
  sandbox_folders: string;
  sandbox_ports: string;
  created_at: number;
}

function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    folderPath: row.folder_path,
    baseBranch: row.base_branch,
    maxRounds: row.max_rounds,
    maxParallel: row.max_parallel,
    leadAsksFirst: row.lead_asks_first === 1,
    checkCommand: row.check_command,
    autoReview: row.auto_review === 1,
    sandbox: row.sandbox === 1,
    sandboxFolders: JSON.parse(row.sandbox_folders) as string[],
    sandboxPorts: JSON.parse(row.sandbox_ports) as number[],
    createdAt: row.created_at,
  };
}

export function listGroups(db: Db): Group[] {
  const rows = db.prepare('SELECT * FROM groups ORDER BY created_at, id').all() as GroupRow[];
  return rows.map(toGroup);
}

export function getGroup(db: Db, id: string): Group | undefined {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
  return row ? toGroup(row) : undefined;
}

export function createGroup(
  db: Db,
  input: { name: string; folderPath?: string | null; baseBranch?: string | null },
  now: number = Date.now(),
): Group {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO groups (id, name, folder_path, base_branch, max_rounds, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.folderPath ?? null,
    input.baseBranch ?? null,
    DEFAULT_MAX_ROUNDS,
    now,
  );
  return getGroup(db, id)!;
}

export function updateGroup(
  db: Db,
  id: string,
  changes: {
    name?: string;
    maxRounds?: number;
    maxParallel?: number;
    leadAsksFirst?: boolean;
    checkCommand?: string;
    autoReview?: boolean;
    sandbox?: boolean;
    sandboxFolders?: string[];
    sandboxPorts?: number[];
    baseBranch?: string;
  },
): Group | undefined {
  const group = getGroup(db, id);
  if (!group) return undefined;
  db.prepare(
    `UPDATE groups SET name = ?, max_rounds = ?, max_parallel = ?, lead_asks_first = ?,
     check_command = ?, auto_review = ?, sandbox = ?, sandbox_folders = ?, sandbox_ports = ?,
     base_branch = ?
     WHERE id = ?`,
  ).run(
    changes.name ?? group.name,
    changes.maxRounds ?? group.maxRounds,
    changes.maxParallel ?? group.maxParallel,
    (changes.leadAsksFirst ?? group.leadAsksFirst) ? 1 : 0,
    changes.checkCommand ?? group.checkCommand,
    (changes.autoReview ?? group.autoReview) ? 1 : 0,
    (changes.sandbox ?? group.sandbox) ? 1 : 0,
    JSON.stringify(changes.sandboxFolders ?? group.sandboxFolders),
    JSON.stringify(changes.sandboxPorts ?? group.sandboxPorts),
    changes.baseBranch ?? group.baseBranch,
    id,
  );
  return getGroup(db, id);
}

/** Removes a group with its agents, messages and audit log. There is no way back. */
export function deleteGroup(db: Db, id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM events WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM agents WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  })();
}

export function getScribeCursor(db: Db, groupId: string): number {
  const row = db.prepare('SELECT scribe_cursor FROM groups WHERE id = ?').get(groupId) as
    { scribe_cursor: number } | undefined;
  return row?.scribe_cursor ?? 0;
}

export function setScribeCursor(db: Db, groupId: string, messageId: number): void {
  db.prepare('UPDATE groups SET scribe_cursor = ? WHERE id = ?').run(messageId, groupId);
}
