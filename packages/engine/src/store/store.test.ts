import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/database.js';
import { createGroup, DEFAULT_MAX_ROUNDS, getGroup, listGroups, updateGroup } from './groups.js';
import { getMessage, insertMessage, listMessages, MAX_PAGE_SIZE } from './messages.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('groups store', () => {
  it('gets a group by id and returns undefined for unknown ids', () => {
    const group = createGroup(db, { name: 'Alpha', folderPath: '/tmp/alpha' }, 1000);
    expect(getGroup(db, group.id)).toEqual({
      id: group.id,
      name: 'Alpha',
      folderPath: '/tmp/alpha',
      baseBranch: null,
      maxRounds: DEFAULT_MAX_ROUNDS,
      maxParallel: 3,
      leadAsksFirst: true,
      checkCommand: '',
      createdAt: 1000,
    });
    expect(getGroup(db, 'missing')).toBeUndefined();
    expect(listGroups(db)).toHaveLength(1);
  });

  it('updates name, limits, settings and base branch', () => {
    const group = createGroup(db, { name: 'Alpha' });
    const updated = updateGroup(db, group.id, { maxRounds: 5, baseBranch: 'main' });
    expect(updated).toMatchObject({ name: 'Alpha', maxRounds: 5, baseBranch: 'main' });
    expect(updateGroup(db, group.id, { maxParallel: 2, leadAsksFirst: false })).toMatchObject({
      maxRounds: 5,
      maxParallel: 2,
      leadAsksFirst: false,
    });
    // Leaving a setting out keeps it, including a false one.
    expect(updateGroup(db, group.id, { name: 'Beta' })).toMatchObject({ leadAsksFirst: false });
    expect(updateGroup(db, 'missing', { name: 'x' })).toBeUndefined();
  });
});

describe('messages store', () => {
  let groupId: string;
  beforeEach(() => {
    groupId = createGroup(db, { name: 'General' }).id;
  });

  function addMessages(count: number, inGroup = groupId): void {
    for (let i = 1; i <= count; i++) {
      insertMessage(db, { groupId: inGroup, authorKind: 'human', body: `message ${i}` });
    }
  }

  it('inserts a message and returns it with an id', () => {
    const message = insertMessage(db, { groupId, authorKind: 'human', body: 'hello' }, 1234);
    expect(message).toEqual({
      id: expect.any(Number),
      groupId,
      authorKind: 'human',
      authorAgentId: null,
      body: 'hello',
      meta: null,
      // A human message starts its own thread.
      threadId: message.id,
      round: null,
      createdAt: 1234,
    });
  });

  it('stores the thread and round of a reply, and leaves other system messages out of threads', () => {
    const question = insertMessage(db, { groupId, authorKind: 'human', body: 'hello' });
    const notice = insertMessage(db, { groupId, authorKind: 'system', body: 'Ada joined' });
    const inThread = insertMessage(db, {
      groupId,
      authorKind: 'system',
      body: 'Round limit reached',
      threadId: question.id,
      round: 2,
    });
    expect([notice.threadId, notice.round]).toEqual([null, null]);
    expect([inThread.threadId, inThread.round]).toEqual([question.id, 2]);
    expect(getMessage(db, inThread.id)).toEqual(inThread);
  });

  it('lists messages oldest first, limited to the most recent page', () => {
    addMessages(5);
    const bodies = listMessages(db, groupId, { limit: 3 }).map((m) => m.body);
    expect(bodies).toEqual(['message 3', 'message 4', 'message 5']);
  });

  it('returns messages after a given id', () => {
    addMessages(5);
    const all = listMessages(db, groupId);
    const after = listMessages(db, groupId, { afterId: all[1]!.id, limit: 2 });
    expect(after.map((m) => m.body)).toEqual(['message 3', 'message 4']);
  });

  it('caps the page size', () => {
    addMessages(MAX_PAGE_SIZE + 5);
    expect(listMessages(db, groupId, { limit: 10_000 })).toHaveLength(MAX_PAGE_SIZE);
  });

  it('only lists messages from the requested group', () => {
    const other = createGroup(db, { name: 'Other' });
    addMessages(2);
    addMessages(3, other.id);
    expect(listMessages(db, groupId)).toHaveLength(2);
    expect(listMessages(db, other.id)).toHaveLength(3);
  });

  it('rejects a message for an unknown group', () => {
    expect(() =>
      insertMessage(db, { groupId: 'missing', authorKind: 'human', body: 'hi' }),
    ).toThrow(/FOREIGN KEY/);
  });

  it('requires an agent id exactly when the author is an agent', () => {
    expect(() => insertMessage(db, { groupId, authorKind: 'agent', body: 'hi' })).toThrow(
      /CHECK constraint/,
    );
    db.prepare(
      `INSERT INTO agents (id, group_id, name, provider, model, role, created_at)
       VALUES ('a1', ?, 'Ada', 'mock', 'mock-1', 'worker', 1)`,
    ).run(groupId);
    expect(() =>
      insertMessage(db, { groupId, authorKind: 'human', authorAgentId: 'a1', body: 'hi' }),
    ).toThrow(/CHECK constraint/);
    const agentMessage = insertMessage(db, {
      groupId,
      authorKind: 'agent',
      authorAgentId: 'a1',
      body: 'hi',
    });
    expect(agentMessage.authorAgentId).toBe('a1');
  });
});
