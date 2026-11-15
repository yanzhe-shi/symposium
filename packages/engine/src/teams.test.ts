import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMemory, writeMemory } from './memory.js';
import type { Agent, Group, HireRequest, HireTeamResult, Message, SavedTeam } from './protocol.js';
import { listEvents } from './store/events.js';
import { createTestApp, type TestApp } from './testing.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function makeGroup(name: string, extra: object = {}): Promise<Group> {
  const res = await t.request({
    method: 'POST',
    url: '/api/groups',
    payload: { name, folderPath: join(t.workDir, name.toLowerCase()), ...extra },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function hire(groupId: string, request: Partial<HireRequest>): Promise<Agent> {
  const res = await t.request({
    method: 'POST',
    url: `/api/groups/${groupId}/agents`,
    payload: { provider: 'mock', model: 'mock', role: 'worker', ...request },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function team(groupId: string): Promise<Agent[]> {
  return (await t.request({ url: `/api/groups/${groupId}/agents` })).json();
}

async function notices(groupId: string): Promise<string[]> {
  const all: Message[] = (await t.request({ url: `/api/groups/${groupId}/messages` })).json();
  return all.filter((message) => message.authorKind === 'system').map((message) => message.body);
}

function save(groupId: string, payload: object) {
  return t.request({ method: 'POST', url: `/api/groups/${groupId}/save-team`, payload });
}

/** A group with a lead and a worker whose settings differ from their roles' defaults. */
async function shop(): Promise<{ group: Group; lea: Agent; ada: Agent }> {
  const group = await makeGroup('Shop');
  const lea = await hire(group.id, { name: 'Lea', role: 'lead', model: 'big' });
  const ada = await hire(group.id, {
    name: 'Ada',
    instructions: 'Frontend only.',
    settings: { commands: 'allowlist', allowlist: ['npm test'] },
  });
  return { group, lea, ada };
}

describe('saved teams', () => {
  it('saves a team and hires it into a new group', async () => {
    const { group } = await shop();
    const res = await save(group.id, { name: 'Shop crew' });
    expect(res.statusCode).toBe(201);
    const saved: SavedTeam = res.json();
    expect(saved).toMatchObject({ id: 'shop-crew', name: 'Shop crew' });
    expect(saved.members.map((member) => [member.name, member.role, member.hasMemory])).toEqual([
      ['Lea', 'lead', false],
      ['Ada', 'worker', false],
    ]);
    expect((await t.request({ url: '/api/teams' })).json()).toEqual([saved]);
    expect((await notices(group.id)).at(-1)).toContain('saved this team as "Shop crew" (2 agents)');

    const blog = await makeGroup('Blog', { team: 'shop-crew' });
    const hired = await team(blog.id);
    expect(hired.map((agent) => agent.name)).toEqual(['Lea', 'Ada']);
    expect(hired[0]).toMatchObject({ role: 'lead', model: 'big' });
    expect(hired[1]).toMatchObject({ instructions: 'Frontend only.' });
    expect(hired[1]!.settings).toMatchObject({ commands: 'allowlist', allowlist: ['npm test'] });
    // New agents, not the old ones moved.
    expect(hired.map((agent) => agent.id)).not.toContain((await team(group.id))[0]!.id);
    expect(listEvents(t.db, blog.id).map((event) => event.kind)).toContain('team.hired');
  });

  it('keeps a file that holds no ids and no keys', async () => {
    const { group } = await shop();
    await save(group.id, { name: 'Shop crew' });
    const text = readFileSync(join(t.dataDir, 'teams', 'shop-crew.json'), 'utf8');
    expect(text).not.toContain(group.id);
    expect(JSON.parse(text).members[1]).toEqual({
      name: 'Ada',
      provider: 'mock',
      model: 'mock',
      role: 'worker',
      roleId: 'worker',
      instructions: 'Frontend only.',
      options: {},
      settings: { commands: 'allowlist', allowlist: ['npm test'] },
    });
  });

  it('takes memory along only when asked', async () => {
    const { group, ada } = await shop();
    await writeMemory(t.dataDir, ada.id, '- The CEO likes short functions');

    await save(group.id, { name: 'Plain' });
    const plain = await makeGroup('Plain', { team: 'plain' });
    expect(await readMemory(t.dataDir, (await team(plain.id))[1]!.id)).toBe('');

    const saved: SavedTeam = (await save(group.id, { name: 'Wise', withMemory: true })).json();
    expect(saved.members.map((member) => member.hasMemory)).toEqual([false, true]);
    const wise = await makeGroup('Wise', { team: 'wise' });
    const memory = await readMemory(t.dataDir, (await team(wise.id))[1]!.id);
    expect(memory).toContain('- The CEO likes short functions');
    expect(memory).toContain('· Joined "Wise"');
    expect(memory).toContain('from the saved team "Wise"');
    expect(await notices(wise.id)).toContain('The team "Wise" brought along what they remember.');
    // The agent it was saved from keeps its own memory as it was.
    expect(await readMemory(t.dataDir, ada.id)).toBe('- The CEO likes short functions');
  });

  it('asks before writing over a saved team of the same name', async () => {
    const { group, ada } = await shop();
    await save(group.id, { name: 'Shop crew' });
    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}/agents/${ada.id}` });

    const again = await save(group.id, { name: 'shop  CREW' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('already a saved team called "Shop crew"');

    const replaced = await save(group.id, { name: 'Shop crew', replace: true });
    expect(replaced.statusCode).toBe(201);
    expect(replaced.json().members).toHaveLength(1);
  });

  it('refuses a name without letters or digits, and an empty team', async () => {
    const { group } = await shop();
    expect((await save(group.id, { name: ' !! ' })).statusCode).toBe(400);
    const empty = await makeGroup('Empty');
    const res = await save(empty.id, { name: 'Nobody' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Nobody is on the team yet');
  });

  it('hires into a group that has people, leaving out who does not fit', async () => {
    const { group } = await shop();
    await save(group.id, { name: 'Shop crew' });
    const blog = await makeGroup('Blog');
    await hire(blog.id, { name: 'Max', role: 'lead' });

    const res = await t.request({
      method: 'POST',
      url: `/api/groups/${blog.id}/hire-team`,
      payload: { teamId: 'shop-crew' },
    });
    expect(res.statusCode).toBe(201);
    const result: HireTeamResult = res.json();
    expect(result.hired.map((agent) => agent.name)).toEqual(['Ada']);
    expect(result.skipped).toEqual(['Lea: Max is already the lead. Fire them first.']);
    expect((await notices(blog.id)).at(-1)).toBe(
      'Not hired from the saved team "Shop crew": Lea: Max is already the lead. Fire them first.',
    );
  });

  it('falls back to the kind of a role that was deleted', async () => {
    const group = await makeGroup('Shop');
    await t.request({
      method: 'POST',
      url: '/api/roles',
      payload: { title: 'Designer', kind: 'worker', text: 'You design the screens.' },
    });
    await hire(group.id, { name: 'Dee', roleId: 'designer' });
    await save(group.id, { name: 'Design' });
    const dee = (await team(group.id))[0]!;
    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}/agents/${dee.id}` });
    expect((await t.request({ method: 'DELETE', url: '/api/roles/designer' })).statusCode).toBe(
      200,
    );

    const blog = await makeGroup('Blog', { team: 'design' });
    expect((await team(blog.id))[0]).toMatchObject({
      name: 'Dee',
      role: 'worker',
      roleId: 'worker',
    });
  });

  it('skips a file edited into something unreadable, and a member that is not valid', async () => {
    const dir = join(t.dataDir, 'teams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(
      join(dir, 'odd.json'),
      JSON.stringify({
        name: 'Odd',
        members: [
          { name: 'Ada', provider: 'mock', model: 'mock', role: 'worker' },
          { name: 'Bob', provider: 'nothing', model: 'x', role: 'worker' },
          'not a member',
        ],
      }),
    );
    const list: SavedTeam[] = (await t.request({ url: '/api/teams' })).json();
    expect(list.map((saved) => saved.id)).toEqual(['odd']);

    const group = await makeGroup('Shop', { team: 'odd' });
    expect((await team(group.id)).map((agent) => agent.name)).toEqual(['Ada']);
    expect((await notices(group.id)).at(-1)).toContain('Bob: Unknown provider "nothing"');
  });

  it('refuses a team that does not exist before making the group', async () => {
    const res = await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Blog', folderPath: join(t.workDir, 'blog'), team: 'no-such-team' },
    });
    expect(res.statusCode).toBe(404);
    expect((await t.request({ url: '/api/groups' })).json()).toEqual([]);

    const both = await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: {
        name: 'Blog',
        folderPath: join(t.workDir, 'blog'),
        team: 'x',
        starterTeam: 'mock',
      },
    });
    expect(both.statusCode).toBe(400);
  });

  it('deletes a saved team and leaves the agents hired from it', async () => {
    const { group } = await shop();
    await save(group.id, { name: 'Shop crew' });
    const blog = await makeGroup('Blog', { team: 'shop-crew' });

    const res = await t.request({ method: 'DELETE', url: '/api/teams/shop-crew' });
    expect(res.json()).toEqual([]);
    expect((await t.request({ method: 'DELETE', url: '/api/teams/shop-crew' })).statusCode).toBe(
      404,
    );
    expect((await t.request({ method: 'DELETE', url: '/api/teams/..%2Froles' })).statusCode).toBe(
      404,
    );
    expect(await team(blog.id)).toHaveLength(2);
  });
});

describe('sending an agent to another group', () => {
  function send(groupId: string, agentId: string, payload: object) {
    return t.request({
      method: 'POST',
      url: `/api/groups/${groupId}/agents/${agentId}/send`,
      payload,
    });
  }

  it('hires a copy there with its memory, and the agent stays here', async () => {
    const { group, ada } = await shop();
    await writeMemory(t.dataDir, ada.id, '- The CEO likes short functions');
    const blog = await makeGroup('Blog');

    const res = await send(group.id, ada.id, { toGroupId: blog.id });
    expect(res.statusCode).toBe(201);
    const arrived: Agent = res.json();
    expect(arrived).toMatchObject({
      name: 'Ada',
      groupId: blog.id,
      instructions: 'Frontend only.',
    });
    expect(arrived.settings).toMatchObject({ commands: 'allowlist', allowlist: ['npm test'] });
    expect(arrived.id).not.toBe(ada.id);

    const memory = await readMemory(t.dataDir, arrived.id);
    expect(memory).toContain('- The CEO likes short functions');
    expect(memory).toContain('You came to this project from "Shop".');
    expect(await readMemory(t.dataDir, ada.id)).toBe('- The CEO likes short functions');

    expect((await team(group.id)).map((agent) => agent.name)).toEqual(['Lea', 'Ada']);
    expect((await notices(group.id)).at(-1)).toBe(
      'You sent Ada to "Blog" with what they remember. They stay on this team too.',
    );
    expect((await notices(blog.id)).at(-1)).toBe(
      'Ada came over from "Shop" with what they remember.',
    );
    expect(listEvents(t.db, group.id).map((event) => event.kind)).toContain('agent.sent');
    expect(listEvents(t.db, blog.id).map((event) => event.kind)).toContain('agent.arrived');
  });

  it('can leave the memory behind, and can make the agent leave this team', async () => {
    const { group, ada } = await shop();
    await writeMemory(t.dataDir, ada.id, '- A note');
    const blog = await makeGroup('Blog');

    const res = await send(group.id, ada.id, {
      toGroupId: blog.id,
      withMemory: false,
      leave: true,
    });
    expect(res.statusCode).toBe(201);
    expect(await readMemory(t.dataDir, res.json().id)).toBe('');
    expect((await team(group.id)).map((agent) => agent.name)).toEqual(['Lea']);
    const told = await notices(group.id);
    expect(told.at(-2)).toBe('You sent Ada to "Blog".');
    expect(told.at(-1)).toContain('Ada left the team');
  });

  it('says why when the name or the seat is taken there, and takes another name', async () => {
    const { group, lea, ada } = await shop();
    const blog = await makeGroup('Blog');
    await hire(blog.id, { name: 'Ada' });
    await hire(blog.id, { name: 'Max', role: 'lead' });

    const taken = await send(group.id, ada.id, { toGroupId: blog.id });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe('Ada is already on the team');
    const seat = await send(group.id, lea.id, { toGroupId: blog.id });
    expect(seat.statusCode).toBe(409);
    expect(seat.json().error).toContain('Max is already the lead');
    // Nothing happened here either.
    expect(await team(group.id)).toHaveLength(2);

    const renamed = await send(group.id, ada.id, { toGroupId: blog.id, name: 'Ada2' });
    expect(renamed.statusCode).toBe(201);
    expect((await notices(group.id)).at(-1)).toContain('You sent Ada to "Blog" as Ada2.');
  });

  it('keeps the notes of someone of that name who worked there before', async () => {
    const { group, ada } = await shop();
    await writeMemory(t.dataDir, ada.id, '- From the shop');
    const blog = await makeGroup('Blog');
    const old = await hire(blog.id, { name: 'Ada' });
    await writeMemory(t.dataDir, old.id, '- From the blog');
    await t.request({ method: 'DELETE', url: `/api/groups/${blog.id}/agents/${old.id}` });

    const arrived: Agent = (await send(group.id, ada.id, { toGroupId: blog.id })).json();
    expect(arrived.id).toBe(old.id);
    const memory = await readMemory(t.dataDir, arrived.id);
    expect(memory.indexOf('- From the blog')).toBeLessThan(memory.indexOf('- From the shop'));
  });

  it('refuses the same group, a group that is not there and an agent who left', async () => {
    const { group, ada } = await shop();
    expect((await send(group.id, ada.id, { toGroupId: group.id })).statusCode).toBe(400);
    expect((await send(group.id, ada.id, { toGroupId: 'nowhere' })).statusCode).toBe(404);
    const blog = await makeGroup('Blog');
    expect((await send(blog.id, ada.id, { toGroupId: group.id })).statusCode).toBe(404);
    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}/agents/${ada.id}` });
    expect((await send(group.id, ada.id, { toGroupId: blog.id })).statusCode).toBe(409);
  });
});
