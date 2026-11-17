import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  MockAdapter,
  privateNetworkAvailable,
  sandboxAvailable,
  type MockReply,
} from '@symposium/adapters';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Group, Message } from '../protocol.js';
import { listEvents } from '../store/events.js';
import { createTestApp, type TestApp } from '../testing.js';
import {
  decideSandbox,
  validateSandboxFolders,
  validateSandboxPorts,
  type SandboxInput,
} from './sandbox.js';

// Some systems and most containers do not allow bubblewrap.
const realSandbox = await sandboxAvailable();
// And pasta, for a network of its own, is not everywhere.
const realNetwork = await privateNetworkAvailable();

const HOME = '/home/cleo';
const worker: SandboxInput = {
  home: HOME,
  dataDir: '/home/cleo/.symposium',
  uid: 1000,
  projectFolder: '/home/cleo/shop',
  cwd: '/home/cleo/.symposium/worktrees/g/ada',
  canEdit: true,
  provider: 'claude-code',
  extraFolders: [],
  privateNetwork: true,
  hostPorts: [],
  enginePort: 4400,
};

describe('decideSandbox', () => {
  it("lets a worker write in its worktree, the package caches and its provider's login", () => {
    const sandbox = decideSandbox(worker);
    expect(sandbox.writable).toContain(worker.cwd);
    expect(sandbox.writable).toContain('/home/cleo/.npm');
    expect(sandbox.writable).toContain('/home/cleo/.claude');
    expect(sandbox.writable).not.toContain(worker.projectFolder);
    // The project stays readable: the worktree's git data lives there.
    expect(sandbox.readOnly).toContain(worker.projectFolder);
    // The provider's settings cannot be changed for the user's own next session.
    expect(sandbox.readOnly).toContain('/home/cleo/.claude/settings.json');
  });

  it('hides keys, logins, the session sockets, temporary folders and Symposium’s own data', () => {
    const { hidden } = decideSandbox(worker);
    for (const path of [
      '/home/cleo/.ssh',
      '/home/cleo/.gnupg',
      '/home/cleo/.config/gh',
      '/home/cleo/.netrc',
      '/home/cleo/.claude/projects',
      '/home/cleo/.symposium',
      '/run/user/1000',
      '/tmp',
    ]) {
      expect(hidden).toContain(path);
    }
  });

  it('lets an agent that only reads change nothing of the project', () => {
    const sandbox = decideSandbox({ ...worker, cwd: worker.projectFolder, canEdit: false });
    expect(sandbox.writable).not.toContain(worker.projectFolder);
    expect(sandbox.readOnly).toContain(worker.projectFolder);
  });

  it("shows a reviewer the worker's folder, read-only", () => {
    const sandbox = decideSandbox({ ...worker, canEdit: false, provider: 'antigravity' });
    expect(sandbox.writable).not.toContain(worker.cwd);
    expect(sandbox.readOnly).toEqual([worker.projectFolder, worker.cwd]);
    expect(sandbox.writable).toContain('/home/cleo/.gemini');
    expect(sandbox.writable).not.toContain('/home/cleo/.claude');
    // Another provider's login is none of its business.
    expect(sandbox.hidden).toContain('/home/cleo/.claude');
    expect(sandbox.hidden).toContain('/home/cleo/.claude.json');
    expect(sandbox.hidden).not.toContain('/home/cleo/.gemini');
  });

  it('adds the folders the human named, and no login for a process that is no provider', () => {
    const sandbox = decideSandbox({
      ...worker,
      provider: undefined,
      extraFolders: ['/home/cleo/.cache/build'],
    });
    expect(sandbox.writable).toContain('/home/cleo/.cache/build');
    expect(sandbox.writable).not.toContain('/home/cleo/.claude');
    expect(sandbox.hidden).toContain('/home/cleo/.claude');
    expect(sandbox.hidden).toContain('/home/cleo/.gemini');
  });
});

describe('the network of a sandbox', () => {
  it('is its own where the computer can, reaching none of this computer by default', () => {
    expect(decideSandbox(worker).network).toEqual({ hostPorts: [] });
  });

  it("lets through the ports the human named, and never the engine's own", () => {
    const sandbox = decideSandbox({ ...worker, hostPorts: [5432, 4400, 6379] });
    expect(sandbox.network).toEqual({ hostPorts: [5432, 6379] });
  });

  it("is the computer's own where it cannot have one", () => {
    expect(decideSandbox({ ...worker, privateNetwork: false }).network).toBe('host');
  });
});

describe('validateSandboxPorts', () => {
  it('sorts the ports and drops repeats', () => {
    expect(validateSandboxPorts([6379, 5432, 6379], 4400)).toEqual({ ports: [5432, 6379] });
  });

  it("refuses Symposium's own port", () => {
    expect(validateSandboxPorts([5432, 4400], 4400)).toHaveProperty('error');
  });
});

describe('validateSandboxFolders', () => {
  it('tidies the list', () => {
    expect(
      validateSandboxFolders([' /data/cache/ ', '/data/cache', '', '/opt/x/../y'], HOME),
    ).toEqual({ folders: ['/data/cache', '/opt/y'] });
  });

  it('refuses a path that is not full, the whole disk and the whole home folder', () => {
    expect(validateSandboxFolders(['cache'], HOME)).toHaveProperty('error');
    expect(validateSandboxFolders(['/'], HOME)).toHaveProperty('error');
    expect(validateSandboxFolders(['/home/cleo/'], HOME)).toHaveProperty('error');
    expect(validateSandboxFolders(['/home/cleo/x'], HOME)).toEqual({ folders: ['/home/cleo/x'] });
  });
});

describe('the sandbox on a team', () => {
  let t: TestApp;
  let group: Group;
  let folder: string;

  async function start(canSandbox: boolean, canIsolateNetwork = false): Promise<void> {
    t = await createTestApp({
      canSandbox: async () => canSandbox,
      canIsolateNetwork: async () => canIsolateNetwork,
    });
    folder = join(t.workDir, 'shop');
    group = (
      await t.request({
        method: 'POST',
        url: '/api/groups',
        payload: { name: 'Shop', folderPath: folder },
      })
    ).json();
  }
  afterEach(async () => {
    await t.close();
  });

  function setGroup(changes: Record<string, unknown>) {
    return t.request({ method: 'PATCH', url: `/api/groups/${group.id}`, payload: changes });
  }

  async function hire(name: string, role: Agent['role'], script: MockReply[]): Promise<Agent> {
    t.mocks.set(name, new MockAdapter(script));
    return (
      await t.request({
        method: 'POST',
        url: `/api/groups/${group.id}/agents`,
        payload: { name, role, provider: 'mock', model: 'mock' },
      })
    ).json();
  }

  async function say(body: string): Promise<void> {
    await t.request({ method: 'POST', url: `/api/groups/${group.id}/messages`, payload: { body } });
    await t.app.symposium.runner.waitForIdle(group.id);
  }

  const firstTask = (name: string) => t.mocks.get(name)!.calls[0]!;

  it('is on for a new group, and the human can switch it off or add folders', async () => {
    await start(true);
    expect(group).toMatchObject({ sandbox: true, sandboxFolders: [] });
    expect((await setGroup({ sandboxFolders: ['/data/cache/'] })).json().sandboxFolders).toEqual([
      '/data/cache',
    ]);
    expect((await setGroup({ sandbox: false })).json()).toMatchObject({
      sandbox: false,
      sandboxFolders: ['/data/cache'],
    });
    const refused = await setGroup({ sandboxFolders: ['/'] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('too much');
  });

  it('gives every turn its sandbox: a worker its worktree, a lead nothing to write', async () => {
    await start(true);
    await setGroup({ leadAsksFirst: false, sandboxFolders: ['/data/cache'] });
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Done.' }]);
    const ada = await hire('Ada', 'worker', [{ text: 'Built.', files: { 'cart.ts': 'v1\n' } }]);
    await say('Build a shop');

    const adaTask = firstTask('Ada');
    expect(adaTask.workingDirectory).toContain(ada.id);
    expect(adaTask.sandbox!.writable).toContain(adaTask.workingDirectory);
    expect(adaTask.sandbox!.writable).toContain('/data/cache');
    expect(adaTask.sandbox!.readOnly).toContain(folder);
    expect(adaTask.sandbox!.hidden).toContain(t.dataDir);
    expect(adaTask.systemPrompt).toContain('You work in a sandbox. Your tools and commands');

    const leaTask = firstTask('Lea');
    expect(leaTask.workingDirectory).toBe(folder);
    expect(leaTask.sandbox!.writable).not.toContain(folder);
    expect(leaTask.sandbox!.readOnly).toContain(folder);
    expect(leaTask.systemPrompt).toContain('Nothing you run can change a file');

    const turns = listEvents(t.db, group.id).filter((event) => event.kind === 'agent.turn');
    expect(turns.map((turn) => turn.detail.sandboxed)).toEqual([true, true, true]);
  });

  it('keeps the ports the human names, and refuses the engine’s own', async () => {
    await start(true, true);
    expect(group.sandboxPorts).toEqual([]);
    expect((await setGroup({ sandboxPorts: [6379, 5432] })).json().sandboxPorts).toEqual([
      5432, 6379,
    ]);
    const refused = await setGroup({ sandboxPorts: [4400] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain("Symposium's own");
    expect((await setGroup({ sandboxPorts: [70000] })).statusCode).toBe(400);
  });

  it('gives a turn a network of its own where the computer can', async () => {
    await start(true, true);
    await setGroup({ sandboxPorts: [5432] });
    await hire('Ada', 'worker', [{ text: 'Built.' }]);
    await say('@Ada build the cart');
    expect(firstTask('Ada').sandbox!.network).toEqual({ hostPorts: [5432] });
    expect(firstTask('Ada').systemPrompt).toContain(
      'no program on this computer, except on port 5432 of localhost',
    );
    const turn = listEvents(t.db, group.id).find((event) => event.kind === 'agent.turn');
    expect(turn!.detail.privateNetwork).toBe(true);
  });

  it('gives a turn the computer’s network where it cannot have its own', async () => {
    await start(true, false);
    await hire('Ada', 'worker', [{ text: 'Built.' }]);
    await say('@Ada build the cart');
    expect(firstTask('Ada').sandbox!.network).toBe('host');
    expect(firstTask('Ada').systemPrompt).not.toContain('no program on this computer');
  });

  it('gives none when the human switched it off', async () => {
    await start(true);
    await setGroup({ sandbox: false });
    await hire('Ada', 'worker', [{ text: 'Built.' }]);
    await say('@Ada build the cart');
    expect(firstTask('Ada').sandbox).toBeUndefined();
    expect(firstTask('Ada').systemPrompt).not.toContain('sandbox');
  });

  it('gives none where the computer cannot sandbox, and says so in the log', async () => {
    await start(false);
    await hire('Ada', 'worker', [{ text: 'Built.' }]);
    await say('@Ada build the cart');
    expect(firstTask('Ada').sandbox).toBeUndefined();
    const turn = listEvents(t.db, group.id).find((event) => event.kind === 'agent.turn');
    expect(turn!.detail.sandboxed).toBe(false);
  });

  // The real thing. Some systems and most containers do not allow bubblewrap: skipped there.
  it.skipIf(!realSandbox)(
    'holds the check command to the worktree, so a worker’s code cannot write elsewhere',
    async () => {
      await start(true);
      const escape = join(folder, 'escaped.txt');
      await setGroup({
        checkCommand: `echo ok > checked.txt && cat cart.ts && { echo x > ${escape}; } 2>/dev/null || echo "project refused"`,
      });
      await hire('Ada', 'worker', [{ text: 'Built.', files: { 'cart.ts': 'v1\n' } }]);
      await say('@Ada build the cart');

      const all: Message[] = (
        await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })
      ).json();
      const diff = all.find((message) => message.meta?.type === 'diff');
      expect(diff!.meta).toMatchObject({
        check: { status: 'passed', output: 'v1\nproject refused\n' },
      });
      expect(existsSync(escape)).toBe(false);
      expect(existsSync(join(firstTask('Ada').workingDirectory, 'checked.txt'))).toBe(true);
    },
  );

  // Needs pasta as well. A server on this computer stands in for Symposium's API.
  it.skipIf(!realSandbox || !realNetwork)(
    'keeps the check command from programs on this computer, except the ports named',
    async () => {
      const servers = await Promise.all([listen(), listen()]);
      try {
        const [named, other] = servers.map((server) => (server.address() as AddressInfo).port);
        await start(true, true);
        await setGroup({
          sandboxPorts: [named],
          checkCommand: [named, other]
            .map(
              (port) =>
                `node -e "fetch('http://127.0.0.1:${port}/').then(() => console.log('${port} reached'), () => console.log('${port} refused'))"`,
            )
            .join(' && '),
        });
        await hire('Ada', 'worker', [{ text: 'Built.', files: { 'cart.ts': 'v1\n' } }]);
        await say('@Ada build the cart');

        const all: Message[] = (
          await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })
        ).json();
        const diff = all.find((message) => message.meta?.type === 'diff');
        expect(diff!.meta).toMatchObject({
          check: { status: 'passed', output: `${named} reached\n${other} refused\n` },
        });
      } finally {
        servers.forEach((server) => server.close());
      }
    },
  );
});

/** A server on this computer's localhost, on a free port. */
function listen(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_request, response) => response.end('hi'));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
