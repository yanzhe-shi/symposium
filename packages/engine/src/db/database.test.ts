import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { getSchemaVersion, migrations, runMigrations } from './migrations.js';

describe('openDatabase', () => {
  let tempDir: string | undefined;
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('applies every migration to a fresh database', () => {
    const db = openDatabase(':memory:');
    expect(getSchemaVersion(db)).toBe(migrations.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual(expect.arrayContaining(['agents', 'groups', 'messages']));
  });

  it('enables foreign keys', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is safe to run migrations twice', () => {
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(migrations.length);
  });

  it('moves groups on the old default round limit to the new one (migration 4)', () => {
    const db = new Database(':memory:');
    db.exec(migrations.slice(0, 3).join('\n'));
    db.pragma('user_version = 3');
    db.prepare("INSERT INTO groups (id, name, created_at) VALUES ('old', 'Old default', 1)").run();
    db.prepare(
      "INSERT INTO groups (id, name, max_rounds, created_at) VALUES ('own', 'Chosen', 2, 1)",
    ).run();
    db.prepare(
      "INSERT INTO messages (group_id, author_kind, body, created_at) VALUES ('old', 'human', 'hi', 1)",
    ).run();

    runMigrations(db);
    const rounds = db.prepare('SELECT id, max_rounds, max_parallel, lead_asks_first FROM groups');
    expect(rounds.all()).toEqual([
      { id: 'old', max_rounds: 6, max_parallel: 3, lead_asks_first: 1 },
      { id: 'own', max_rounds: 2, max_parallel: 3, lead_asks_first: 1 },
    ]);
    // Messages from before threads existed stay outside any thread.
    expect(db.prepare('SELECT thread_id, round FROM messages').get()).toEqual({
      thread_id: null,
      round: null,
    });
  });

  it('refuses a database from a newer engine', () => {
    const db = openDatabase(':memory:');
    db.pragma(`user_version = ${migrations.length + 1}`);
    expect(() => runMigrations(db)).toThrow(/newer than this engine supports/);
  });

  it('creates the parent folder and keeps data across reopen', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'symposium-db-'));
    const path = join(tempDir, 'nested', 'symposium.db');

    const first = openDatabase(path);
    first.prepare("INSERT INTO groups (id, name, created_at) VALUES ('g1', 'Test', 1)").run();
    first.close();

    const second = openDatabase(path);
    expect(second.prepare('SELECT name FROM groups').pluck().get()).toBe('Test');
    second.close();
  });
});
