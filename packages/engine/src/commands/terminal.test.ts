import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from '../git/workspaces.js';
import type { Agent, Group, ServerEvent, TerminalRun } from '../protocol.js';
import { listEvents } from '../store/events.js';
import { createTestApp, waitFor, type TestApp } from '../testing.js';
import { MAX_RUNS_PER_GROUP } from './terminal.js';

let t: TestApp;
let group: Group;
let folder: string;
let events: ServerEvent[];

beforeEach(async () => {
  t = await createTestApp();
  folder = join(t.workDir, 'shop');
  group = (
    await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Shop', folderPath: folder },
    })
  ).json();
  events = [];
  const hub = t.app.symposium.ctx.hub;
  const broadcast = hub.broadcast.bind(hub);
  hub.broadcast = (groupId, event) => {
    events.push(event);
    broadcast(groupId, event);
  };
});
afterEach(async () => {
  await t.close();
});

function run(where: string, command: string, headers: Record<string, string> = {}) {
  return t.request({
    method: 'POST',
    url: `/api/groups/${group.id}/terminal`,
    payload: { where, command },
    headers,
  });
}

function stop(runId: string) {
  return t.request({ method: 'POST', url: `/api/groups/${group.id}/terminal/${runId}/stop` });
}

function outputOf(runId: string): string {
  return events
    .filter((event) => event.type === 'terminal.output')
    .filter((event) => event.runId === runId)
    .map((event) => event.text)
    .join('');
}

/** Waits for the run to end and returns its exit code. */
async function exitOf(runId: string): Promise<number | null> {
  const ended = () =>
    events.filter((event) => event.type === 'terminal.exit').find((event) => event.runId === runId);
  await waitFor(() => ended() !== undefined);
  return ended()!.exitCode;
}

describe("the human's terminal", () => {
  it('runs a command in the project folder and streams what it prints', async () => {
    const res = await run('project', 'pwd && echo oops >&2; exit 3');
    expect(res.statusCode).toBe(201);
    const started: TerminalRun = res.json();
    expect(started).toMatchObject({
      where: 'project',
      folder: 'the project folder',
      command: 'pwd && echo oops >&2; exit 3',
    });

    expect(await exitOf(started.runId)).toBe(3);
    expect(outputOf(started.runId)).toContain(realpathSync(folder));
    expect(outputOf(started.runId)).toContain('oops');

    const [logged] = listEvents(t.db, group.id).filter((event) => event.kind === 'human.command');
    expect(logged!.detail).toMatchObject({
      command: 'pwd && echo oops >&2; exit 3',
      folder: 'the project folder',
      exitCode: 3,
    });
  });

  it("runs in an agent's worktree, and the live view picks up what changed", async () => {
    t.mocks.set('Ada', new MockAdapter([{ text: 'Hi.' }]));
    const ada: Agent = (
      await t.request({
        method: 'POST',
        url: `/api/groups/${group.id}/agents`,
        payload: { name: 'Ada', role: 'worker', provider: 'mock', model: 'mock' },
      })
    ).json();
    // No worktree before Ada's first turn.
    const early = await run(ada.id, 'pwd');
    expect(early.statusCode).toBe(404);
    expect(early.json().error).toMatch(/Ada's worktree does not exist yet/);

    await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      payload: { body: '@Ada hello' },
    });
    await t.app.symposium.runner.waitForIdle(group.id);

    const started: TerminalRun = (await run(ada.id, 'pwd && echo draft > notes.txt')).json();
    expect(started.folder).toBe("Ada's worktree");
    expect(await exitOf(started.runId)).toBe(0);
    expect(outputOf(started.runId).trim()).toBe(realpathSync(worktreePath(t.dataDir, group, ada)));

    const changed = () =>
      events
        .filter((event) => event.type === 'worktree.changed')
        .filter((e) => e.agentId === ada.id);
    await waitFor(() => changed().some((event) => event.changes.files.includes('notes.txt')));
    expect(listEvents(t.db, group.id).at(-1)).toMatchObject({
      kind: 'human.command',
      agentId: ada.id,
    });
  });

  it('stops a running command and everything it started', async () => {
    const started: TerminalRun = (await run('project', 'sleep 30 & sleep 30; echo late')).json();
    expect((await stop(started.runId)).json()).toEqual({ stopped: true });
    expect(await exitOf(started.runId)).toBeNull();
    expect(outputOf(started.runId)).not.toContain('late');
    // Nothing left to stop, here or under a made-up id.
    expect((await stop(started.runId)).json()).toEqual({ stopped: false });
    expect((await stop('no-such-run')).json()).toEqual({ stopped: false });
  });

  it('reports a command the shell cannot find', async () => {
    const started: TerminalRun = (await run('project', 'definitely-not-a-command-xyz')).json();
    expect(await exitOf(started.runId)).toBe(127);
    expect(outputOf(started.runId)).toMatch(/not found/);
  });

  it('refuses what makes no sense, and too many at once', async () => {
    expect((await run('project', '   ')).statusCode).toBe(400);
    expect((await run('nobody', 'pwd')).statusCode).toBe(404);
    expect(
      (
        await t.request({
          method: 'POST',
          url: `/api/groups/${group.id}/terminal`,
          payload: { where: 'project' },
        })
      ).statusCode,
    ).toBe(400);

    const runs: TerminalRun[] = [];
    for (let i = 0; i < MAX_RUNS_PER_GROUP; i++) {
      runs.push((await run('project', 'sleep 30')).json());
    }
    const extra = await run('project', 'echo one too many');
    expect(extra.statusCode).toBe(409);
    expect(extra.json().error).toMatch(/Too many commands/);

    // A finished run frees its place.
    await stop(runs[0]!.runId);
    await exitOf(runs[0]!.runId);
    expect((await run('project', 'true')).statusCode).toBe(201);
    // The rest are stopped when the server closes.
  });

  it('is closed to other websites, like every route', async () => {
    const res = await run('project', 'echo pwned', { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    const rebound = await run('project', 'echo pwned', { host: 'evil.example' });
    expect(rebound.statusCode).toBe(403);
    expect(events.filter((event) => event.type.startsWith('terminal.'))).toEqual([]);
  });
});
