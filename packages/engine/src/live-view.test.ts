import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MockAdapter, type AgentEvent, type MockResponder } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uncommittedChanges, worktreePath } from './git/workspaces.js';
import type {
  Agent,
  AgentProgress,
  FileContent,
  FolderListing,
  Group,
  HireRequest,
  ServerEvent,
  WorktreeChanges,
} from './protocol.js';
import { MAX_FILE_BYTES } from './routes/files.js';
import { PacedTask } from './routing/paced.js';
import { listEvents } from './store/events.js';
import { createTestApp, waitFor, type TestApp } from './testing.js';

let t: TestApp;
let group: Group;
let folder: string;
let events: ServerEvent[];

beforeEach(async () => {
  t = await createTestApp({ liveChangesIntervalMs: 20 });
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

async function hire(
  name: string,
  role: HireRequest['role'],
  script: ConstructorParameters<typeof MockAdapter>[0],
): Promise<Agent> {
  t.mocks.set(name, new MockAdapter(script));
  const res = await t.request({
    method: 'POST',
    url: `/api/groups/${group.id}/agents`,
    payload: { name, role, provider: 'mock', model: 'mock' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function say(body: string): Promise<void> {
  const res = await t.request({
    method: 'POST',
    url: `/api/groups/${group.id}/messages`,
    payload: { body },
  });
  expect(res.statusCode).toBe(201);
}

function settle(): Promise<void> {
  return t.app.symposium.runner.waitForIdle(group.id);
}

function get(path: string, query: Record<string, string>) {
  return t.request({ url: `/api/groups/${group.id}/${path}`, query });
}

function liveDiffs(agentId: string): WorktreeChanges[] {
  return events
    .filter((event) => event.type === 'worktree.changed')
    .filter((event) => event.agentId === agentId)
    .map((event) => event.changes);
}

const READ: AgentEvent = { kind: 'read', tool: 'Read', target: 'src/cart.ts', summary: 'read x' };
const EDIT: AgentEvent = { kind: 'edit', tool: 'Edit', target: 'src/cart.ts', summary: 'edited x' };
const SAID: AgentEvent = { kind: 'text', summary: 'Let me look at the cart.' };

describe('agent progress', () => {
  it('shows what an agent does during its turn and logs every tool call', async () => {
    const ada = await hire('Ada', 'worker', [{ text: 'Done.', events: [SAID, READ, EDIT] }]);
    await say('@Ada fix the cart');
    await settle();

    const shown = events.filter((event) => event.type === 'agent.progress');
    expect(shown.map((event) => event.progress.event)).toEqual([SAID, READ, EDIT]);
    expect(shown.every((event) => event.progress.agentId === ada.id)).toBe(true);
    // Progress arrives while the agent is working, before it goes idle.
    const order = events.map((event) =>
      event.type === 'agent.activity' ? event.activity : event.type,
    );
    expect(order.indexOf('working')).toBeLessThan(order.indexOf('agent.progress'));
    expect(order.lastIndexOf('agent.progress')).toBeLessThan(order.indexOf('idle'));

    // What the agent said along the way is shown, not logged. Tool calls are logged.
    const logged = listEvents(t.db, group.id).filter((event) => event.kind === 'agent.tool');
    expect(logged.map((event) => [event.agentId, event.detail])).toEqual([
      [ada.id, READ],
      [ada.id, EDIT],
    ]);
  });

  it('gives a page that just opened the recent tool calls, oldest first', async () => {
    const ada = await hire('Ada', 'worker', [{ text: 'Done.', events: [READ, EDIT] }]);
    const bob = await hire('Bob', 'worker', [{ text: 'Done.', events: [READ] }]);
    await say('@Ada go');
    await settle();
    await say('@Bob go');
    await settle();

    const activity: AgentProgress[] = (await get('activity', {})).json();
    expect(activity.map((entry) => [entry.agentId, entry.event])).toEqual([
      [ada.id, READ],
      [ada.id, EDIT],
      [bob.id, READ],
    ]);
    const shown = events.filter((event) => event.type === 'agent.progress');
    expect(activity.map((entry) => entry.at)).toEqual(shown.map((event) => event.progress.at));

    const newest: AgentProgress[] = (await get('activity', { limit: '1' })).json();
    expect(newest.map((entry) => entry.agentId)).toEqual([bob.id]);
  });

  it('carries on when a listener fails', async () => {
    await hire('Ada', 'worker', [{ text: 'Done.', events: [READ] }]);
    const hub = t.app.symposium.ctx.hub;
    const broadcast = hub.broadcast.bind(hub);
    hub.broadcast = (groupId, event) => {
      if (event.type === 'agent.progress') throw new Error('socket trouble');
      broadcast(groupId, event);
    };
    await say('@Ada go');
    await settle();
    const messages = (await t.request({ url: `/api/groups/${group.id}/messages` })).json();
    expect(messages.at(-1).body).toBe('Done.');
  });
});

describe('live changes', () => {
  /** Writes a file, reports the edit, then keeps the turn going for a while. */
  const editing: MockResponder = (task) => {
    mkdirSync(join(task.workingDirectory, 'src'), { recursive: true });
    writeFileSync(join(task.workingDirectory, 'src/cart.ts'), 'export const cart = [];\n');
    writeFileSync(join(task.workingDirectory, 'project.md'), '# Shop\n\nNow with a cart.\n');
    task.onEvent?.(EDIT);
    return { text: 'Added the cart.', delayMs: 300 };
  };

  it("shows an agent's uncommitted diff while it works, and clears it after the commit", async () => {
    const ada = await hire('Ada', 'worker', editing);
    await say('@Ada add a cart');
    await waitFor(() => liveDiffs(ada.id).length > 0);

    // The turn is still going: nothing is committed, and the live diff has both files.
    expect((await t.request({ url: `/api/groups/${group.id}/run` })).json().running).toBe(true);
    const [during] = liveDiffs(ada.id);
    expect(during!.files).toEqual(['project.md', 'src/cart.ts']);
    expect(during!.diff).toContain('+Now with a cart.');
    expect(during!.diff).toContain('+++ b/src/cart.ts');
    expect(during!.diff).toContain('+export const cart = [];');
    expect(during!.truncated).toBe(false);

    // A page that opens now gets the same from the route.
    const fetched: WorktreeChanges = (await get('changes', { where: ada.id })).json();
    expect(fetched).toEqual(during);

    // Looking staged nothing: the new file is still untracked.
    const worktree = worktreePath(t.dataDir, group, ada);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktree }).toString();
    expect(status).toContain('?? src/');
    expect(status).toContain(' M project.md');

    await settle();
    expect(liveDiffs(ada.id).at(-1)).toEqual({ files: [], diff: '', truncated: false });
    expect((await get('changes', { where: ada.id })).json().files).toEqual([]);
  });

  it('paces the pushes when edits come quickly', async () => {
    const busy: MockResponder = async (task) => {
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(task.workingDirectory, `file-${i}.txt`), 'x\n');
        task.onEvent?.(EDIT);
        await sleep(2);
      }
      return { text: 'Twenty files.' };
    };
    const ada = await hire('Ada', 'worker', busy);
    await say('@Ada go');
    await settle();

    const pushes = liveDiffs(ada.id);
    expect(pushes.length).toBeGreaterThan(1);
    expect(pushes.length).toBeLessThan(15);
    expect(pushes.at(-1)!.files).toEqual([]);
  });

  it('keeps showing what a stopped turn left behind', async () => {
    const ada = await hire('Ada', 'worker', (task) => {
      writeFileSync(join(task.workingDirectory, 'half.ts'), 'half done\n');
      task.onEvent?.(EDIT);
      return { text: 'never sent', delayMs: 5000 };
    });
    await say('@Ada start');
    await waitFor(() => liveDiffs(ada.id).length > 0);
    await t.request({ method: 'POST', url: `/api/groups/${group.id}/stop` });

    expect(liveDiffs(ada.id).at(-1)!.files).toEqual(['half.ts']);
  });

  it('has nothing to show for agents who read the project folder', async () => {
    const lea = await hire('Lea', 'lead', [{ text: 'Plan.', events: [READ, EDIT] }]);
    await say('Plan it');
    await settle();
    expect(liveDiffs(lea.id)).toEqual([]);
    expect((await get('changes', { where: lea.id })).json()).toEqual({
      files: [],
      diff: '',
      truncated: false,
    });
    expect((await get('changes', { where: 'nobody' })).statusCode).toBe(404);
  });

  it('reports nothing for a folder that is not a worktree', async () => {
    expect(await uncommittedChanges(join(t.workDir, 'missing'))).toEqual({
      files: [],
      diff: '',
      truncated: false,
    });
  });
});

describe('PacedTask', () => {
  it('runs at once, then at most once per interval, and once more at the end', async () => {
    const runs: number[] = [];
    const paced = new PacedTask(async () => {
      runs.push(Date.now());
    }, 60);

    paced.request();
    paced.request();
    paced.request();
    await sleep(5);
    expect(runs).toHaveLength(1);

    await sleep(100);
    // The requests made during the pause were answered by a single run.
    expect(runs).toHaveLength(2);
    expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(55);

    await sleep(100);
    expect(runs).toHaveLength(2);

    await paced.finish();
    expect(runs).toHaveLength(3);
    paced.request();
    await sleep(100);
    expect(runs).toHaveLength(3);
  });

  it('survives a run that fails', async () => {
    let calls = 0;
    const paced = new PacedTask(async () => {
      calls++;
      throw new Error('git went away');
    }, 10);
    paced.request();
    await paced.finish();
    expect(calls).toBe(2);
  });
});

describe('file routes', () => {
  beforeEach(() => {
    mkdirSync(join(folder, 'src/lib'), { recursive: true });
    writeFileSync(join(folder, 'src/cart.ts'), 'export const cart = [];\n');
    writeFileSync(join(folder, 'src/lib/money.ts'), 'export const euro = "€";\n');
    writeFileSync(join(folder, 'zebra.txt'), 'z\n');
    writeFileSync(join(folder, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    writeFileSync(join(folder, 'big.log'), 'x'.repeat(MAX_FILE_BYTES + 1));
    // Outside the project folder: must never be readable through it.
    writeFileSync(join(t.workDir, 'secret.txt'), 'top secret\n');
    mkdirSync(join(t.workDir, 'private'));
    writeFileSync(join(t.workDir, 'private/key.txt'), 'key\n');
    symlinkSync(join(t.workDir, 'secret.txt'), join(folder, 'leak.txt'));
    symlinkSync(join(t.workDir, 'private'), join(folder, 'leak-dir'));
    symlinkSync(join(folder, 'src/cart.ts'), join(folder, 'cart-link.ts'));
  });

  it('lists a folder with folders first and without .git', async () => {
    const top: FolderListing = (await get('files', { where: 'project' })).json();
    expect(top.path).toBe('');
    expect(top.truncated).toBe(false);
    expect(top.entries.map((entry) => `${entry.type} ${entry.name}`)).toEqual([
      'dir leak-dir',
      'dir src',
      'file big.log',
      'file cart-link.ts',
      'file leak.txt',
      'file logo.png',
      'file project.md',
      'file zebra.txt',
    ]);
    expect(top.entries.find((entry) => entry.name === 'zebra.txt')!.size).toBe(2);

    const src: FolderListing = (await get('files', { where: 'project', path: 'src/' })).json();
    expect(src.path).toBe('src');
    expect(src.entries.map((entry) => entry.name)).toEqual(['lib', 'cart.ts']);
    expect((await get('files', { where: 'project', path: 'zebra.txt' })).statusCode).toBe(400);
    expect((await get('files', { where: 'project', path: 'nope' })).statusCode).toBe(404);
    expect((await get('files', {})).statusCode).toBe(400);
  });

  it('reads a text file, and says why it will not show a binary or a huge one', async () => {
    const file: FileContent = (
      await get('file', { where: 'project', path: 'src/lib/money.ts' })
    ).json();
    expect(file).toEqual({
      path: 'src/lib/money.ts',
      size: Buffer.byteLength('export const euro = "€";\n'),
      content: 'export const euro = "€";\n',
    });
    // A link that stays inside the folder is fine.
    expect((await get('file', { where: 'project', path: 'cart-link.ts' })).json().content).toBe(
      'export const cart = [];\n',
    );

    expect((await get('file', { where: 'project', path: 'logo.png' })).json()).toEqual({
      path: 'logo.png',
      size: 8,
      content: null,
      skipped: 'binary',
    });
    expect((await get('file', { where: 'project', path: 'big.log' })).json()).toEqual({
      path: 'big.log',
      size: MAX_FILE_BYTES + 1,
      content: null,
      skipped: 'too-large',
    });
    expect((await get('file', { where: 'project', path: 'src' })).statusCode).toBe(400);
    expect((await get('file', { where: 'project' })).statusCode).toBe(400);
  });

  it('never leaves the folder: no "..", no absolute paths, no symlinks out, no .git', async () => {
    const outside = [
      '../secret.txt',
      'src/../../secret.txt',
      '..',
      join(t.workDir, 'secret.txt'),
      '/etc/passwd',
      'leak.txt',
      'leak-dir/key.txt',
      '.git/config',
      'src/../.git/HEAD',
    ];
    for (const path of outside) {
      const res = await get('file', { where: 'project', path });
      expect([path, res.statusCode >= 400]).toEqual([path, true]);
      expect(res.body).not.toContain('top secret');
      expect(res.body).not.toContain('key');
    }
    for (const path of ['..', '../private', 'leak-dir', '.git', '/']) {
      const res = await get('files', { where: 'project', path });
      expect([path, res.statusCode >= 400]).toEqual([path, true]);
    }
    expect((await get('file', { where: 'project', path: '../secret.txt' })).json().error).toMatch(
      /outside the folder/,
    );
    expect((await get('file', { where: 'project', path: 'leak.txt' })).json().error).toMatch(
      /leads outside the folder/,
    );
  });

  it("shows an agent's worktree, which is separate from the project folder", async () => {
    const ada = await hire('Ada', 'worker', [
      { text: 'Added.', files: { 'src/checkout.ts': 'export const checkout = 1;\n' } },
    ]);
    const lea = await hire('Lea', 'lead', [{ text: 'Plan.' }]);
    // Before Ada's first turn she has no worktree.
    expect((await get('files', { where: ada.id })).statusCode).toBe(404);

    await say('@Ada add checkout');
    await settle();

    const src: FolderListing = (await get('files', { where: ada.id, path: 'src' })).json();
    expect(src.entries.map((entry) => entry.name)).toEqual(['checkout.ts']);
    expect((await get('file', { where: ada.id, path: 'src/checkout.ts' })).json().content).toBe(
      'export const checkout = 1;\n',
    );
    // The worktree's `.git` file, which points into the project's repository, stays hidden.
    const top: FolderListing = (await get('files', { where: ada.id })).json();
    expect(top.entries.map((entry) => entry.name)).not.toContain('.git');
    expect((await get('file', { where: ada.id, path: '.git' })).statusCode).toBe(404);

    // Nothing was merged, so the project folder does not have the file.
    expect((await get('file', { where: 'project', path: 'src/checkout.ts' })).statusCode).toBe(404);
    // Lea reads the project folder and has no worktree. Unknown agents are not found.
    expect((await get('files', { where: lea.id })).statusCode).toBe(404);
    expect((await get('files', { where: 'nobody' })).statusCode).toBe(404);
  });
});
