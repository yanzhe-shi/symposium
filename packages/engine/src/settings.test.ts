import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from './git/workspaces.js';
import type {
  Agent,
  AgentSettings,
  Group,
  HireRequest,
  Message,
  UpdateAgentRequest,
} from './protocol.js';
import {
  defaultSettings,
  resolveSettings,
  settingsOverrides,
  validateSettings,
} from './settings.js';
import { listEvents } from './store/events.js';
import { createTestApp, type TestApp } from './testing.js';

let t: TestApp;
let group: Group;
beforeEach(async () => {
  t = await createTestApp();
  group = (
    await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Shop', folderPath: join(t.workDir, 'shop') },
    })
  ).json();
});
afterEach(async () => {
  await t.close();
});

function hire(name: string, role: HireRequest['role'], settings?: Partial<AgentSettings>) {
  return t.request({
    method: 'POST',
    url: `/api/groups/${group.id}/agents`,
    payload: { name, role, provider: 'mock', model: 'mock', settings },
  });
}

function edit(agent: Agent, changes: UpdateAgentRequest | Record<string, unknown>) {
  return t.request({
    method: 'PATCH',
    url: `/api/groups/${group.id}/agents/${agent.id}`,
    payload: changes,
  });
}

async function say(body: string): Promise<void> {
  await t.request({ method: 'POST', url: `/api/groups/${group.id}/messages`, payload: { body } });
  await t.app.symposium.runner.waitForIdle(group.id);
}

async function chat(): Promise<Message[]> {
  return (await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })).json();
}

describe('agent settings', () => {
  it('start from the role: workers edit, leads and reviewers read, the scribe has no tools', () => {
    expect(defaultSettings('worker')).toEqual({
      files: 'edit',
      commands: 'off',
      allowlist: [],
      effort: 'default',
    });
    expect(defaultSettings('lead').files).toBe('read');
    expect(defaultSettings('reviewer').files).toBe('read');
    expect(defaultSettings('scribe').files).toBe('none');
  });

  it('stores only what differs from the role, so the rest keeps following the role', () => {
    expect(
      settingsOverrides('worker', { files: 'edit', effort: 'default', allowlist: [] }),
    ).toEqual({});
    expect(settingsOverrides('lead', { files: 'edit', effort: 'high' })).toEqual({
      files: 'edit',
      effort: 'high',
    });
    expect(resolveSettings('lead', { effort: 'high' })).toEqual({
      files: 'read',
      commands: 'off',
      allowlist: [],
      effort: 'high',
    });
  });

  it('checks every value and explains what is wrong', () => {
    expect(validateSettings('worker', undefined)).toEqual({});
    expect(
      validateSettings('worker', {
        files: 'read',
        commands: 'allowlist',
        allowlist: [' pnpm test ', 'pnpm test', '', 'npm run *'],
        effort: 'xhigh',
      }),
    ).toEqual({
      files: 'read',
      commands: 'allowlist',
      allowlist: ['pnpm test', 'npm run *'],
      effort: 'xhigh',
    });
    expect(() => validateSettings('worker', { files: 'everything' })).toThrow(/File access/);
    expect(() => validateSettings('worker', { commands: 'yolo' })).toThrow(/Command mode/);
    expect(() => validateSettings('worker', { effort: 'extreme' })).toThrow(/Effort/);
    expect(() => validateSettings('worker', { allowlist: 'pnpm test' })).toThrow(/allow-list/);
    expect(() => validateSettings('worker', { allowlist: ['a\nb'] })).toThrow(/one line/);
    expect(() => validateSettings('worker', { shell: true })).toThrow(/Unknown setting "shell"/);
    expect(() => validateSettings('scribe', { files: 'read' })).toThrow(/scribe/);
    expect(validateSettings('scribe', { files: 'none', effort: 'low' })).toEqual({
      files: 'none',
      effort: 'low',
    });
  });

  it('gives a new agent its role defaults, or the settings chosen when hiring', async () => {
    const ada: Agent = (await hire('Ada', 'worker')).json();
    expect(ada.settings).toEqual(defaultSettings('worker'));

    const lea: Agent = (await hire('Lea', 'lead', { files: 'edit', effort: 'high' })).json();
    expect(lea.settings).toMatchObject({ files: 'edit', effort: 'high', commands: 'off' });

    const bad = await hire('Rex', 'reviewer', { effort: 'extreme' as never });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Effort must be one of/);
    expect((await hire('Sam', 'scribe', { files: 'edit' })).statusCode).toBe(400);
  });

  it('passes file access, effort and command mode to the adapter', async () => {
    await hire('Ada', 'worker', { effort: 'max' });
    await hire('Rex', 'reviewer', { files: 'none' });
    await say('@Ada @Rex hello');

    expect(t.mocks.get('Ada')!.calls[0]).toMatchObject({
      access: 'edit',
      effort: 'max',
      commands: 'off',
    });
    const rex = t.mocks.get('Rex')!.calls[0]!;
    expect(rex).toMatchObject({ access: 'none', effort: 'default' });
    expect(rex.systemPrompt).toContain('You have no tools.');
    expect(rex.systemPrompt).toContain('The CEO set this file access for you');
    expect(t.mocks.get('Ada')!.calls[0]!.systemPrompt).not.toContain(
      'The CEO set this file access',
    );
  });

  it("uses the scribe's effort setting", async () => {
    await hire('Lea', 'lead');
    await hire('Sam', 'scribe', { effort: 'low' });
    t.mocks.set('Sam', new MockAdapter([{ text: '# Shop\n\nUpdated.' }]));
    await say('Hello');
    expect(t.mocks.get('Sam')!.calls[0]).toMatchObject({ access: 'none', effort: 'low' });
  });

  it('gives anyone with edit access their own worktree, whatever the role', async () => {
    const lea: Agent = (await hire('Lea', 'lead', { files: 'edit' })).json();
    const ada: Agent = (await hire('Ada', 'worker', { files: 'read' })).json();
    t.mocks.set(
      'Lea',
      new MockAdapter([{ text: 'Fixed the typo myself.', files: { 'README.md': '# Shop\n' } }]),
    );
    await say('@Lea fix the typo. @Ada take a look.');

    const leaTask = t.mocks.get('Lea')!.calls[0]!;
    expect(leaTask.access).toBe('edit');
    expect(leaTask.workingDirectory).toBe(worktreePath(t.dataDir, group, lea));
    expect(leaTask.systemPrompt).toContain('own git worktree on branch `symposium/lea`');
    // Her change stays on her branch until the human merges it.
    expect(existsSync(join(group.folderPath!, 'README.md'))).toBe(false);
    const diff = (await chat()).find((m) => m.meta?.type === 'diff')!;
    expect(diff.meta).toMatchObject({ agentId: lea.id, branch: 'symposium/lea' });

    // A worker limited to reading works in the project folder and gets no worktree.
    const adaTask = t.mocks.get('Ada')!.calls[0]!;
    expect(adaTask.access).toBe('read');
    expect(adaTask.workingDirectory).toBe(group.folderPath);
    expect(existsSync(worktreePath(t.dataDir, group, ada))).toBe(false);
  });

  it('ignores settings in a hire proposal: access is for the human to set', async () => {
    await hire('Lea', 'lead');
    t.mocks.set(
      'Lea',
      new MockAdapter([
        {
          text: '```hire\n{"name":"Max","role":"reviewer","provider":"mock","model":"mock","settings":{"files":"edit","commands":"auto"}}\n```',
        },
      ]),
    );
    await say('Plan the team');
    const proposal = (await chat()).find((m) => m.meta?.type === 'hire-proposal')!;
    expect(proposal.meta?.type === 'hire-proposal' && proposal.meta.hire.settings).toEqual({});
    await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${proposal.id}/approve-hire`,
    });
    const agents: Agent[] = (await t.request({ url: `/api/groups/${group.id}/agents` })).json();
    expect(agents.find((a) => a.name === 'Max')!.settings).toEqual(defaultSettings('reviewer'));
  });
});

describe('editing an agent', () => {
  it('changes the model and effort without firing, announces it and logs it', async () => {
    const ada: Agent = (await hire('Ada', 'worker')).json();
    const res = await edit(ada, { model: 'bigger-model', settings: { effort: 'high' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: ada.id,
      name: 'Ada',
      model: 'bigger-model',
      firedAt: null,
      settings: { files: 'edit', effort: 'high' },
    });
    expect((await chat()).at(-1)?.body).toBe(
      'You changed Ada: model mock → bigger-model, effort default → high.',
    );
    const event = listEvents(t.db, group.id).find((e) => e.kind === 'agent.edited')!;
    expect(event.agentId).toBe(ada.id);
    expect(event.detail).toMatchObject({ model: 'bigger-model', settings: { effort: 'high' } });

    // The next turn uses the new settings.
    await say('@Ada hello');
    expect(t.mocks.get('Ada')!.calls[0]).toMatchObject({ model: 'bigger-model', effort: 'high' });
  });

  it('keeps the settings that are not sent, and hands a setting back to the role', async () => {
    const lea: Agent = (await hire('Lea', 'lead', { files: 'edit' })).json();
    const kept = await edit(lea, { settings: { effort: 'low' } });
    expect(kept.json().settings).toMatchObject({ files: 'edit', effort: 'low' });

    // "read" is the lead's default, so the override goes away.
    const back = await edit(lea, { settings: { files: 'read' } });
    expect(back.json().settings).toMatchObject({ files: 'read', effort: 'low' });
    expect(t.db.prepare('SELECT settings FROM agents WHERE id = ?').pluck().get(lea.id)).toBe(
      '{"effort":"low"}',
    );
  });

  it('says nothing when nothing changed', async () => {
    const ada: Agent = (await hire('Ada', 'worker')).json();
    const before = (await chat()).length;
    expect((await edit(ada, { model: 'mock', settings: { files: 'edit' } })).statusCode).toBe(200);
    expect(await chat()).toHaveLength(before);
    expect(listEvents(t.db, group.id).some((e) => e.kind === 'agent.edited')).toBe(false);
  });

  it('applies the same rules as hiring', async () => {
    const lea: Agent = (await hire('Lea', 'lead')).json();
    const ada: Agent = (await hire('Ada', 'worker')).json();

    expect((await edit(ada, { role: 'lead' })).statusCode).toBe(409);
    expect((await edit(lea, { role: 'lead', model: 'other' })).statusCode).toBe(200);
    expect((await edit(ada, { model: '  ' })).statusCode).toBe(400);
    expect((await edit(ada, { provider: 'nope' })).statusCode).toBe(400);
    expect((await edit(ada, { settings: { files: 'write' } })).statusCode).toBe(400);
    // An agent keeps its name: its branch and its @mentions depend on it.
    expect((await edit(ada, { name: 'Eve' })).statusCode).toBe(400);
    expect((await edit({ ...ada, id: 'nope' }, { model: 'x' })).statusCode).toBe(404);

    // A worker becomes a reviewer and follows the reviewer's defaults.
    const reviewer = await edit(ada, { role: 'reviewer' });
    expect(reviewer.json()).toMatchObject({ role: 'reviewer', settings: { files: 'read' } });

    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}/agents/${ada.id}` });
    expect((await edit(ada, { model: 'x' })).statusCode).toBe(409);
  });
});

describe('model lists', () => {
  const models = (query: string) => t.request({ url: `/api/providers/${query}` });

  it('lists the models of a provider', async () => {
    expect((await models('mock/models')).json()).toEqual({ models: [{ id: 'mock' }] });
    expect((await models('claude-code/models')).json().models).toContainEqual({ id: 'haiku' });
    expect((await models('nope/models')).statusCode).toBe(404);
  });

  it('asks the Antigravity CLI the agent is set up with', async () => {
    const cli = join(t.workDir, 'fake-agy');
    writeFileSync(cli, "#!/bin/sh\nprintf 'gemini-test\\tGemini Test\\n'\n");
    chmodSync(cli, 0o755);
    const res = await models(`antigravity/models?command=${encodeURIComponent(cli)}`);
    expect(res.json()).toEqual({ models: [{ id: 'gemini-test', label: 'Gemini Test' }] });
  });

  it('falls back to the built-in suggestions when the provider cannot be asked', async () => {
    const missing = encodeURIComponent(join(t.dataDir, 'no-such-cli'));
    const res = await models(`antigravity/models?command=${missing}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toMatch(/Command not found/);
    expect(res.json().models).toContainEqual({ id: 'gemini-3.8-flash-low' });
  });

  it('checks the options like the hire form does', async () => {
    expect((await models('openai-compatible/models?baseUrl=ftp://x')).statusCode).toBe(400);
    expect((await models('openai-compatible/models?apiKeyEnv=sk-secret-key')).statusCode).toBe(400);
    expect((await models('mock/models?other=1')).statusCode).toBe(400);
  });
});
