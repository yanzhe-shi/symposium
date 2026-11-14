import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from './git/workspaces.js';
import { memoryPath } from './memory.js';
import type { Agent, Group, ServerEvent } from './protocol.js';
import { listEvents } from './store/events.js';
import { createTestApp, waitFor, type TestApp } from './testing.js';
import { workspaceFilePath } from './vscode.js';

let t: TestApp;
let folder: string;
let group: Group;

async function makeGroup(name: string, folderPath: string): Promise<Group> {
  return (
    await t.request({ method: 'POST', url: '/api/groups', payload: { name, folderPath } })
  ).json();
}

async function hire(groupId: string, name: string, role: string): Promise<Agent> {
  const res = await t.request({
    method: 'POST',
    url: `/api/groups/${groupId}/agents`,
    payload: { name, provider: 'mock', model: 'mock', role },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const say = (groupId: string, body: string) =>
  t.request({ method: 'POST', url: `/api/groups/${groupId}/messages`, payload: { body } });

beforeEach(async () => {
  t = await createTestApp();
  folder = join(t.workDir, 'shop');
  group = await makeGroup('Shop', folder);
});
afterEach(async () => {
  await t.close();
});

describe('deleting a group', () => {
  it('removes the chat, the team, memory and worktrees, and keeps the project and its branches', async () => {
    const ada = await hire(group.id, 'Ada', 'worker');
    t.mocks.set(
      'Ada',
      new MockAdapter([
        {
          text: 'Done.\n```memory\n- The CEO likes socks\n```',
          files: { 'cart.ts': 'export {};\n' },
        },
      ]),
    );
    await say(group.id, '@Ada build the cart');
    await t.app.symposium.runner.waitForIdle(group.id);

    const worktree = worktreePath(t.dataDir, group, ada);
    const workspaceFile = workspaceFilePath(t.dataDir, group);
    await waitFor(() => existsSync(workspaceFile));
    expect(existsSync(join(worktree, 'cart.ts'))).toBe(true);
    expect(existsSync(memoryPath(t.dataDir, ada.id))).toBe(true);

    const res = await t.request({ method: 'DELETE', url: `/api/groups/${group.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });

    expect((await t.request({ url: '/api/groups' })).json()).toEqual([]);
    expect((await t.request({ url: `/api/groups/${group.id}/messages` })).statusCode).toBe(404);
    expect(listEvents(t.db, group.id)).toEqual([]);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(memoryPath(t.dataDir, ada.id))).toBe(false);
    expect(existsSync(workspaceFile)).toBe(false);

    // The human's own folder is untouched, and committed work stays on the agent's branch.
    expect(existsSync(join(folder, 'project.md'))).toBe(true);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, encoding: 'utf8' });
    expect(git('branch', '--list', 'symposium/ada')).toContain('symposium/ada');
    expect(git('show', 'symposium/ada:cart.ts')).toBe('export {};\n');
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('stops work in progress first and tells open pages', async () => {
    await hire(group.id, 'Ada', 'worker');
    t.mocks.set('Ada', new MockAdapter([{ text: 'Never sent.', delayMs: 60_000 }]));
    const events: ServerEvent[] = [];
    const hub = t.app.symposium.ctx.hub;
    const broadcast = hub.broadcast.bind(hub);
    hub.broadcast = (groupId, event) => {
      events.push(event);
      broadcast(groupId, event);
    };

    await say(group.id, '@Ada build the cart');
    await waitFor(() => t.app.symposium.runner.isRunning(group.id));
    const res = await t.request({ method: 'DELETE', url: `/api/groups/${group.id}` });

    expect(res.statusCode).toBe(200);
    expect(t.app.symposium.runner.isRunning(group.id)).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'group.deleted' });
    expect(
      events.some(
        (event) => event.type === 'message.created' && event.message.body === 'Never sent.',
      ),
    ).toBe(false);
  });

  it('leaves other groups alone', async () => {
    const other = await makeGroup('Blog', join(t.workDir, 'blog'));
    await hire(other.id, 'Ada', 'lead');
    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}` });

    expect((await t.request({ url: '/api/groups' })).json()).toMatchObject([{ id: other.id }]);
    expect((await t.request({ url: `/api/groups/${other.id}/agents` })).json()).toHaveLength(1);
  });

  it('answers 404 for a group that does not exist', async () => {
    expect((await t.request({ method: 'DELETE', url: '/api/groups/nope' })).statusCode).toBe(404);
  });
});
