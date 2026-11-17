import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Group, Message, SystemInfo } from './protocol.js';
import { starterTeam } from './system.js';
import { createTestApp, type TestApp } from './testing.js';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

const createGroup = (payload: object) =>
  t.request({ method: 'POST', url: '/api/groups', payload: { name: 'Shop', ...payload } });

describe('system checks', () => {
  it('says what is installed, without running anything', async () => {
    const info: SystemInfo = (await t.request({ url: '/api/system' })).json();
    // The tests need git, and no test may find a real editor.
    expect(info.git).toBe(true);
    expect(info.vscode).toBe(false);
    expect(info.providers.mock).toBe(true);
    // Tests run without a sandbox on every computer.
    expect(info.sandbox).toEqual({ works: false, without: [], network: false });
    expect(Object.keys(info.providers).sort()).toEqual([
      'antigravity',
      'claude-code',
      'mock',
      'openai-compatible',
    ]);
  });
});

describe('starter team', () => {
  it('puts the scribe on the small model and everyone else on the first suggestion', () => {
    expect(starterTeam('claude-code')).toEqual([
      { name: 'Lea', role: 'lead', provider: 'claude-code', model: 'sonnet' },
      { name: 'Ada', role: 'worker', provider: 'claude-code', model: 'sonnet' },
      { name: 'Rex', role: 'reviewer', provider: 'claude-code', model: 'sonnet' },
      { name: 'Sam', role: 'scribe', provider: 'claude-code', model: 'haiku' },
    ]);
  });

  it('hires the team with the group when the human asks for one', async () => {
    const res = await createGroup({ folderPath: join(t.workDir, 'shop'), starterTeam: 'mock' });
    expect(res.statusCode).toBe(201);
    const group: Group = res.json();
    const team: Agent[] = (await t.request({ url: `/api/groups/${group.id}/agents` })).json();
    expect(team.map((agent) => `${agent.name}:${agent.role}:${agent.provider}`)).toEqual([
      'Lea:lead:mock',
      'Ada:worker:mock',
      'Rex:reviewer:mock',
      'Sam:scribe:mock',
    ]);
    // Role defaults apply: only the worker edits files, and it asks before every command.
    expect(team.map((agent) => agent.settings.files)).toEqual(['read', 'edit', 'read', 'none']);
    expect(team[1]!.settings.commands).toBe('ask');

    // The team is ready to work at once.
    await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      payload: { body: 'Hello' },
    });
    await t.app.symposium.runner.waitForIdle(group.id);
    const chat: Message[] = (await t.request({ url: `/api/groups/${group.id}/messages` })).json();
    expect(chat.some((message) => message.body === 'Lea here.')).toBe(true);
  });

  it('starts empty unless asked, and refuses a provider that cannot edit files', async () => {
    const empty: Group = (await createGroup({ folderPath: join(t.workDir, 'a') })).json();
    expect((await t.request({ url: `/api/groups/${empty.id}/agents` })).json()).toEqual([]);
    const refused = await createGroup({
      folderPath: join(t.workDir, 'b'),
      starterTeam: 'openai-compatible',
    });
    expect(refused.statusCode).toBe(400);
  });
});
