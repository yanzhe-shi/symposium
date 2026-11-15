import type Database from 'better-sqlite3';

/**
 * Ordered list of schema migrations. Never edit a migration that has shipped:
 * add a new one to the end instead. The current version is stored in PRAGMA user_version.
 */
export const migrations: readonly string[] = [
  // 1: groups, agents, messages
  `
  CREATE TABLE groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    folder_path TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE agents (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups(id),
    name       TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT NOT NULL,
    role       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (group_id, name)
  );

  CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id        TEXT NOT NULL REFERENCES groups(id),
    author_kind     TEXT NOT NULL CHECK (author_kind IN ('human', 'agent', 'system')),
    author_agent_id TEXT REFERENCES agents(id),
    body            TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    CHECK ((author_kind = 'agent') = (author_agent_id IS NOT NULL))
  );

  CREATE INDEX messages_group_id ON messages (group_id, id);
  `,

  // 2: groups and agents (milestone 3)
  `
  ALTER TABLE groups ADD COLUMN max_rounds INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE groups ADD COLUMN base_branch TEXT;
  ALTER TABLE agents ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE agents ADD COLUMN fired_at INTEGER;
  ALTER TABLE messages ADD COLUMN meta TEXT;

  -- Audit log: hires, fires, agent turns, git operations. Messages are logged in messages.
  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   TEXT NOT NULL REFERENCES groups(id),
    agent_id   TEXT REFERENCES agents(id),
    kind       TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_group_id ON events (group_id, id);
  `,

  // 3: scribe (milestone 6). The newest message the scribe has already written into project.md.
  `
  ALTER TABLE groups ADD COLUMN scribe_cursor INTEGER NOT NULL DEFAULT 0;
  `,

  // 4: non-blocking chat (milestone 8). Every human message starts a thread; replies carry the
  // thread and how many hand-offs deep they are. Groups get a cap on agents working at once and
  // the "lead asks before starting work" setting. The default round limit goes from 3 to 6, and
  // groups still on the old default move with it.
  `
  ALTER TABLE messages ADD COLUMN thread_id INTEGER;
  ALTER TABLE messages ADD COLUMN round INTEGER;
  ALTER TABLE groups ADD COLUMN max_parallel INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE groups ADD COLUMN lead_asks_first INTEGER NOT NULL DEFAULT 1;
  UPDATE groups SET max_rounds = 6 WHERE max_rounds = 3;
  `,

  // 5: per-agent settings (milestone 9): file access, command mode, allow-list and effort.
  // Only the values that differ from the role's defaults are stored.
  `
  ALTER TABLE agents ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
  `,

  // 6: custom roles (milestone 15). `role` stays the kind the engine acts on. `role_id` names
  // the role the agent was hired into; null means the built-in role of that kind.
  `
  ALTER TABLE agents ADD COLUMN role_id TEXT;
  `,

  // 7: checks (milestone 20). The command the engine runs on each worker's change. Empty: none.
  `
  ALTER TABLE groups ADD COLUMN check_command TEXT NOT NULL DEFAULT '';
  `,

  // 8: reviews (milestone 20). Whether a reviewer looks at every worker's change by itself.
  `
  ALTER TABLE groups ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 1;
  `,
];

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies every migration newer than the database's current version, each in its own transaction. */
export function runMigrations(db: Database.Database): void {
  const current = getSchemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${current} is newer than this engine supports (${migrations.length}).`,
    );
  }
  for (let version = current + 1; version <= migrations.length; version++) {
    const sql = migrations[version - 1]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
