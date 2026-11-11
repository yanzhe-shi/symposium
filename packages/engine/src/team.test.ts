import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Group, HireRequest, Message } from './protocol.js';
import { listEvents } from './store/events.js';
import { createTestApp, type TestApp } from './testing.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function makeGroup(name = 'Shop', folder = join(t.workDir, 'shop')): Promise<Group> {
  const res = await t.request({
    method: 'POST',
    url: '/api/groups',
    payload: { name, folderPath: folder },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

function hireRequest(overrides: Partial<HireRequest> = {}): HireRequest {
  return { name: 'Ada', provider: 'mock', model: 'mock', role: 'worker', ...overrides };
}

async function hire(groupId: string, overrides: Partial<HireRequest> = {}) {
  return t.request({
    method: 'POST',
    url: `/api/groups/${groupId}/agents`,
    payload: hireRequest(overrides),
  });
}

async function messages(groupId: string): Promise<Message[]> {
  return (await t.request({ url: `/api/groups/${groupId}/messages` })).json();
}

describe('groups', () => {
  it('creates a group and its project folder', async () => {
    const folder = join(t.workDir, 'new', 'project');
    const group = await makeGroup('Shop', folder);
    expect(group).toMatchObject({ name: 'Shop', folderPath: folder, maxRounds: 3 });
    expect(existsSync(folder)).toBe(true);
    const list = (await t.request({ url: '/api/groups' })).json();
    expect(list).toHaveLength(1);
  });

  it.each([
    ['a relative path', 'projects/shop'],
    ['the home folder', homedir()],
    ['the root folder', '/'],
  ])('refuses %s', async (_label, folderPath) => {
    const res = await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'X', folderPath },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a folder inside Symposium's data folder", async () => {
    const res = await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'X', folderPath: join(t.dataDir, 'worktrees') },
    });
    expect(res.statusCode).toBe(400);
  });

  it('updates the round limit within bounds', async () => {
    const group = await makeGroup();
    const ok = await t.request({
      method: 'PATCH',
      url: `/api/groups/${group.id}`,
      payload: { maxRounds: 5 },
    });
    expect(ok.json()).toMatchObject({ maxRounds: 5 });
    const tooMany = await t.request({
      method: 'PATCH',
      url: `/api/groups/${group.id}`,
      payload: { maxRounds: 99 },
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('hiring and firing', () => {
  it('hires an agent, announces it and logs it', async () => {
    const group = await makeGroup();
    const res = await hire(group.id, { instructions: '  Frontend specialist  ' });
    expect(res.statusCode).toBe(201);
    const agent: Agent = res.json();
    expect(agent).toMatchObject({
      name: 'Ada',
      provider: 'mock',
      role: 'worker',
      instructions: 'Frontend specialist',
      firedAt: null,
    });

    const list = (await t.request({ url: `/api/groups/${group.id}/agents` })).json();
    expect(list).toHaveLength(1);
    expect((await messages(group.id)).at(-1)?.body).toMatch(/Ada joined as worker/);
    expect(listEvents(t.db, group.id).map((e) => e.kind)).toContain('agent.hired');
  });

  it.each([
    ['a name that cannot be mentioned', { name: 'Ada Lovelace' }],
    ['a reserved name', { name: 'everyone' }],
    ['an unknown provider', { provider: 'skynet' as HireRequest['provider'] }],
    ['an unknown role', { role: 'ceo' as HireRequest['role'] }],
    ['an empty model', { model: '  ' }],
    ['a pasted API key', { options: { apiKeyEnv: 'sk-abc123 secret' } }],
    ['a bad base URL', { options: { baseUrl: 'ftp://x' } }],
  ])('rejects %s', async (_label, overrides) => {
    const group = await makeGroup();
    expect((await hire(group.id, overrides)).statusCode).toBe(400);
  });

  it('rejects a duplicate name regardless of case', async () => {
    const group = await makeGroup();
    await hire(group.id);
    expect((await hire(group.id, { name: 'ADA' })).statusCode).toBe(409);
  });

  it('allows one lead and one scribe per group', async () => {
    const group = await makeGroup();
    expect((await hire(group.id, { name: 'Lea', role: 'lead' })).statusCode).toBe(201);
    expect((await hire(group.id, { name: 'Leo', role: 'lead' })).statusCode).toBe(409);
    expect((await hire(group.id, { name: 'Sam', role: 'scribe' })).statusCode).toBe(201);
    expect((await hire(group.id, { name: 'Sal', role: 'scribe' })).statusCode).toBe(409);
    expect((await hire(group.id, { name: 'Bob', role: 'worker' })).statusCode).toBe(201);
    expect((await hire(group.id, { name: 'Bea', role: 'worker' })).statusCode).toBe(201);
  });

  it('fires an agent and brings it back on rehire with the same id', async () => {
    const group = await makeGroup();
    const agent: Agent = (await hire(group.id)).json();

    const fired = await t.request({
      method: 'DELETE',
      url: `/api/groups/${group.id}/agents/${agent.id}`,
    });
    expect(fired.json()).toMatchObject({ id: agent.id, firedAt: expect.any(Number) });
    expect((await t.request({ url: `/api/groups/${group.id}/agents` })).json()).toEqual([]);
    const all = await t.request({ url: `/api/groups/${group.id}/agents?includeFired=true` });
    expect(all.json()).toHaveLength(1);

    const rehired: Agent = (await hire(group.id, { role: 'reviewer' })).json();
    expect(rehired).toMatchObject({ id: agent.id, role: 'reviewer', firedAt: null });
  });

  it('refuses to hire into a group without a project folder', async () => {
    const { createGroup } = await import('./store/groups.js');
    const legacy = createGroup(t.db, { name: 'Old' });
    const res = await hire(legacy.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no project folder/);
  });

  it('lists providers and roles for the hire form', async () => {
    const providers = (await t.request({ url: '/api/providers' })).json();
    expect(providers.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining(['claude-code', 'antigravity', 'openai-compatible', 'mock']),
    );
    const roles = (await t.request({ url: '/api/roles' })).json();
    expect(roles.map((r: { kind: string }) => r.kind)).toEqual([
      'lead',
      'worker',
      'reviewer',
      'scribe',
    ]);
  });
});
