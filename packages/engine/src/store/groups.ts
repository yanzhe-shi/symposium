import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { Group } from '../protocol.js';

export const DEFAULT_GROUP_NAME = 'General';

interface GroupRow {
  id: string;
  name: string;
  folder_path: string | null;
  created_at: number;
}

function toGroup(row: GroupRow): Group {
  return { id: row.id, name: row.name, folderPath: row.folder_path, createdAt: row.created_at };
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
  input: { name: string; folderPath?: string | null },
  now: number = Date.now(),
): Group {
  const group: Group = {
    id: randomUUID(),
    name: input.name,
    folderPath: input.folderPath ?? null,
    createdAt: now,
  };
  db.prepare('INSERT INTO groups (id, name, folder_path, created_at) VALUES (?, ?, ?, ?)').run(
    group.id,
    group.name,
    group.folderPath,
    group.createdAt,
  );
  return group;
}

/**
 * Until milestone 3 adds group creation, the engine needs one group to chat in.
 * Creates it on first start and returns the first group on every later start.
 */
export function ensureDefaultGroup(db: Db): Group {
  return db.transaction(() => {
    const existing = listGroups(db)[0];
    return existing ?? createGroup(db, { name: DEFAULT_GROUP_NAME });
  })();
}
