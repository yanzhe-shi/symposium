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
