import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter, type MockReply } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Group, Message } from '../protocol.js';
import { listEvents } from '../store/events.js';
import { createTestApp, type TestApp } from '../testing.js';
import { prepareRepository } from './repository.js';
import { worktreePath } from './workspaces.js';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitAll(cwd: string, message: string): void {
  sh(cwd, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'add', '-A');
  sh(cwd, '-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('prepareRepository', () => {
  it('turns a new folder into a repo with a first commit and project.md', async () => {
    const folder = join(t.workDir, 'fresh');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'notes.txt'), 'existing file');

    const result = await prepareRepository(folder, 'Fresh');
    expect(result.baseBranch).toBe('main');
    expect(result.actions).toEqual([
      'created a git repo',
      'added project.md',
      'made a first commit',
    ]);
    expect(sh(folder, 'ls-files').split('\n').sort()).toEqual(['notes.txt', 'project.md']);
    expect(readFileSync(join(folder, 'project.md'), 'utf8')).toContain('# Fresh');
  });

  it('leaves an existing history alone', async () => {
    const folder = join(t.workDir, 'existing');
    mkdirSync(folder, { recursive: true });
    sh(folder, 'init', '-q', '-b', 'trunk');
    writeFileSync(join(folder, 'app.ts'), 'code');
    commitAll(folder, 'first');
    const head = sh(folder, 'rev-parse', 'HEAD');

    const result = await prepareRepository(folder, 'Existing');
    expect(result.baseBranch).toBe('trunk');
    expect(sh(folder, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(folder, 'status', '--porcelain')).toBe('?? project.md');
  });

  it('refuses a folder inside another repo, and a detached HEAD', async () => {
    const folder = join(t.workDir, 'outer');
    mkdirSync(join(folder, 'inner'), { recursive: true });
    await prepareRepository(folder, 'Outer');
    await expect(prepareRepository(join(folder, 'inner'), 'Inner')).rejects.toThrow(
      /inside the git repo/,
    );

    sh(folder, 'checkout', '-q', '--detach');
    await expect(prepareRepository(folder, 'Outer')).rejects.toThrow(/no branch checked out/);
  });
});

describe('worker isolation and merging', () => {
  let group: Group;
  let folder: string;

  beforeEach(async () => {
    folder = join(t.workDir, 'shop');
    group = (
      await t.request({
        method: 'POST',
        url: '/api/groups',
        payload: { name: 'Shop', folderPath: folder },
      })
    ).json();
  });

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

  async function diffMessages(): Promise<Message[]> {
    const all: Message[] = (
      await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })
    ).json();
    return all.filter((m) => m.meta?.type === 'diff');
  }

  function decide(message: Message, decision: 'merge' | 'discard') {
    return t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${message.id}/${decision}`,
    });
  }

  it('creates a repo for a new group and records the base branch', () => {
    expect(group.baseBranch).toBe('main');
    expect(existsSync(join(folder, '.git'))).toBe(true);
  });

  it('runs workers in their own worktree and leaves the project folder untouched', async () => {
    const ada = await hire('Ada', 'worker', [
      { text: '@Lea Added the cart.', files: { 'src/cart.ts': 'export const cart = [];\n' } },
    ]);
    await hire('Lea', 'lead', [{ text: 'Plan.' }]);
    await say('@Ada add a cart. @Lea plan.');

    expect(t.mocks.get('Ada')!.calls[0]!.workingDirectory).toBe(
      worktreePath(t.dataDir, group, ada),
    );
    expect(t.mocks.get('Lea')!.calls[0]!.workingDirectory).toBe(folder);
    expect(existsSync(join(folder, 'src/cart.ts'))).toBe(false);
    expect(sh(folder, 'log', '-1', '--format=%an', 'symposium/ada')).toBe('Ada (Symposium agent)');
    expect(sh(folder, 'log', '-1', '--format=%s', 'symposium/ada')).toBe('Ada: Added the cart.');

    const [diff] = await diffMessages();
    expect(diff!.meta).toMatchObject({
      type: 'diff',
      status: 'pending',
      branch: 'symposium/ada',
      baseBranch: 'main',
      files: ['src/cart.ts'],
    });
    expect(diff!.meta?.type === 'diff' && diff!.meta.diff).toContain('+export const cart = [];');
  });

  it('merges only when the human approves, then updates the worker from main', async () => {
    await hire('Ada', 'worker', [
      { text: 'Cart.', files: { 'cart.ts': 'v1\n' } },
      { text: 'Checkout.', files: { 'checkout.ts': 'v1\n' } },
    ]);
    await say('@Ada cart');
    const [diff] = await diffMessages();

    const merged = await decide(diff!, 'merge');
    expect(merged.statusCode).toBe(200);
    expect(merged.json().meta.status).toBe('merged');
    expect(readFileSync(join(folder, 'cart.ts'), 'utf8')).toBe('v1\n');
    expect(sh(folder, 'log', '-1', '--format=%s')).toBe(
      'Merge symposium/ada (approved in Symposium)',
    );
    expect(listEvents(t.db, group.id).map((e) => e.kind)).toContain('git.merge');
    expect((await decide(diff!, 'merge')).statusCode).toBe(409);

    // The next diff shows only the new work.
    await say('@Ada checkout');
    const latest = (await diffMessages()).at(-1)!;
    expect(latest.meta).toMatchObject({ status: 'pending', files: ['checkout.ts'] });
  });

  it('marks older diffs as superseded when the worker changes more', async () => {
    await hire('Ada', 'worker', [
      { text: 'One.', files: { 'one.ts': '1\n' } },
      { text: 'Two.', files: { 'two.ts': '2\n' } },
    ]);
    await say('@Ada one');
    await say('@Ada two');
    const [first, second] = await diffMessages();
    expect(first!.meta).toMatchObject({ status: 'superseded' });
    expect(second!.meta).toMatchObject({ status: 'pending', files: ['one.ts', 'two.ts'] });
    expect((await decide(first!, 'merge')).statusCode).toBe(409);
  });

  it('discards unmerged work on request', async () => {
    const ada = await hire('Ada', 'worker', [
      { text: 'Oops.', files: { 'bad.ts': 'bad\n' } },
      { text: 'Fresh start.' },
    ]);
    await say('@Ada try');
    const [diff] = await diffMessages();
    expect((await decide(diff!, 'discard')).json().meta.status).toBe('discarded');
    expect(existsSync(join(worktreePath(t.dataDir, group, ada), 'bad.ts'))).toBe(false);
    expect(existsSync(join(folder, 'bad.ts'))).toBe(false);
  });

  it('backs out of a conflicting merge and leaves main as it was', async () => {
    await hire('Ada', 'worker', [{ text: 'Edited.', files: { 'project.md': 'Ada version\n' } }]);
    await say('@Ada edit project.md');
    writeFileSync(join(folder, 'project.md'), 'CEO version\n');
    commitAll(folder, 'CEO edit');
    const head = sh(folder, 'rev-parse', 'HEAD');

    const [diff] = await diffMessages();
    const res = await decide(diff!, 'merge');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/conflicts with main in: project.md/);
    expect(sh(folder, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(folder, 'status', '--porcelain')).toBe('');
  });

  it('refuses to merge when the project folder is on another branch', async () => {
    await hire('Ada', 'worker', [{ text: 'Done.', files: { 'a.ts': 'a\n' } }]);
    await say('@Ada go');
    sh(folder, 'checkout', '-q', '-b', 'experiment');
    const [diff] = await diffMessages();
    const res = await decide(diff!, 'merge');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/Check out main/);
  });

  it('posts no diff when a worker changes nothing', async () => {
    await hire('Ada', 'worker', [{ text: 'Just thinking.' }]);
    await say('@Ada think');
    expect(await diffMessages()).toEqual([]);
  });
});
