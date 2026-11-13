import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAdapter } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from '../git/workspaces.js';
import type { Agent, FolderChoices, Group, HireRequest } from '../protocol.js';
import { createTestApp, waitFor, type TestApp } from '../testing.js';
import { workspaceFilePath, writeWorkspaceFile } from '../vscode.js';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

describe('choosing a project folder', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  const dirs = (path?: string) =>
    t.request({ url: '/api/fs/dirs', query: path === undefined ? {} : { path } });

  it('says where new projects go by default', async () => {
    const res = await t.request({ url: '/api/fs/projects' });
    expect(res.json()).toEqual({ path: join(t.workDir, 'projects') });
  });

  it('lists the folders in a folder: no files, nothing hidden', async () => {
    const base = join(t.workDir, 'pick');
    for (const name of ['zeta', 'Alpha', '.hidden', 'beta/inner']) {
      mkdirSync(join(base, name), { recursive: true });
    }
    writeFileSync(join(base, 'notes.txt'), 'a file');

    const listing: FolderChoices = (await dirs(base)).json();
    expect(listing).toEqual({
      path: base,
      parent: t.workDir,
      dirs: ['Alpha', 'beta', 'zeta'],
      truncated: false,
    });
    expect((await dirs(join(base, 'beta'))).json().dirs).toEqual(['inner']);
    expect((await dirs('/')).json().parent).toBeNull();
  });

  it('starts in the projects folder, or at home while that does not exist', async () => {
    expect((await dirs()).json().path).toBe(homedir());
    mkdirSync(join(t.workDir, 'projects', 'shop'), { recursive: true });
    expect((await dirs()).json()).toMatchObject({
      path: join(t.workDir, 'projects'),
      dirs: ['shop'],
    });
  });

  it('refuses relative paths and folders that are not there', async () => {
    expect((await dirs('relative/path')).statusCode).toBe(400);
    expect((await dirs(join(t.workDir, 'missing'))).statusCode).toBe(404);
    mkdirSync(t.workDir, { recursive: true });
    writeFileSync(join(t.workDir, 'file.txt'), 'x');
    expect((await dirs(join(t.workDir, 'file.txt'))).statusCode).toBe(404);
  });
});

describe('VS Code', () => {
  let group: Group;
  let folder: string;
  let argsFile: string;
  let editorDir: string;
  afterEach(() => {
    rmSync(editorDir, { recursive: true, force: true });
  });

  /** A stand-in for `code` that writes down how it was called. */
  async function start(withEditor = true): Promise<void> {
    editorDir = mkdtempSync(join(tmpdir(), 'symposium-editor-'));
    const editor = join(editorDir, 'fake-code');
    argsFile = join(editorDir, 'code-args.txt');
    writeFileSync(editor, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`);
    chmodSync(editor, 0o755);
    t = await createTestApp({ vscodeCommand: withEditor ? editor : join(editorDir, 'missing') });
    folder = join(t.workDir, 'shop');
    group = (
      await t.request({
        method: 'POST',
        url: '/api/groups',
        payload: { name: 'Sock Shop!', folderPath: folder },
      })
    ).json();
  }

  async function hire(name: string, role: HireRequest['role']): Promise<Agent> {
    t.mocks.set(
      name,
      new MockAdapter([{ text: 'Done.', files: role === 'worker' ? { 'src/a.ts': 'a\n' } : {} }]),
    );
    return (
      await t.request({
        method: 'POST',
        url: `/api/groups/${group.id}/agents`,
        payload: { name, role, provider: 'mock', model: 'mock' },
      })
    ).json();
  }

  async function turn(body: string): Promise<void> {
    await t.request({ method: 'POST', url: `/api/groups/${group.id}/messages`, payload: { body } });
    await t.app.symposium.runner.waitForIdle(group.id);
  }

  const open = (payload: Record<string, string> = {}) =>
    t.request({ method: 'POST', url: `/api/groups/${group.id}/open`, payload });
  /** What the stand-in editor was last started with. */
  async function openedWith(): Promise<string[]> {
    await waitFor(() => existsSync(argsFile));
    return readFileSync(argsFile, 'utf8').trim().split('\n');
  }
  const workspace = () =>
    JSON.parse(readFileSync(workspaceFilePath(t.dataDir, group), 'utf8')) as {
      folders: { name: string; path: string }[];
    };

  it('keeps a workspace file with the project and every worktree', async () => {
    await start();
    const ctx = t.app.symposium.ctx;
    const file = await writeWorkspaceFile(ctx, group);
    expect(file).toBe(
      join(t.dataDir, 'workspaces', `sock-shop-${group.id.slice(0, 8)}.code-workspace`),
    );
    expect(workspace()).toEqual({
      folders: [{ name: 'Sock Shop! (project)', path: folder }],
      settings: {},
    });

    const ada = await hire('Ada', 'worker');
    await hire('Lea', 'lead');
    // Hired, but no worktree until a first turn. The lead never gets one.
    expect((await writeWorkspaceFile(ctx, group)) && workspace().folders).toHaveLength(1);

    await turn('@Ada build. @Lea plan.');
    // The file follows along by itself when a worktree appears.
    await waitFor(() => workspace().folders.length === 2);
    expect(workspace().folders[1]).toEqual({
      name: 'Ada (symposium/ada)',
      path: worktreePath(t.dataDir, group, ada),
    });

    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}/agents/${ada.id}` });
    await waitFor(() => workspace().folders.length === 1);
  });

  it('opens the workspace, a worktree or one file, and nothing outside', async () => {
    await start();
    const ada = await hire('Ada', 'worker');
    expect((await open({ where: ada.id })).statusCode).toBe(404);
    await turn('@Ada build');
    const worktree = realpathSync(worktreePath(t.dataDir, group, ada));

    const whole = await open();
    expect(whole.statusCode).toBe(200);
    expect(await openedWith()).toEqual([workspaceFilePath(t.dataDir, group)]);
    expect(workspace().folders.map((entry) => entry.name)).toEqual([
      'Sock Shop! (project)',
      'Ada (symposium/ada)',
    ]);

    expect((await open({ where: ada.id })).json()).toEqual({ opened: worktree });
    await waitFor(() => readFileSync(argsFile, 'utf8').trim() === worktree);

    expect((await open({ where: ada.id, path: 'src/a.ts' })).statusCode).toBe(200);
    await waitFor(() => readFileSync(argsFile, 'utf8').startsWith('-g'));
    expect(await openedWith()).toEqual(['-g', join(worktree, 'src/a.ts')]);

    expect((await open({ where: 'project' })).json()).toEqual({ opened: realpathSync(folder) });
    for (const path of ['../../etc/passwd', '/etc/passwd', '.git/config', 'nope.ts']) {
      const res = await open({ where: 'project', path });
      expect([path, res.statusCode >= 400]).toEqual([path, true]);
    }
    expect((await open({ path: 'src/a.ts' })).statusCode).toBe(400);
    expect((await open({ where: 'nobody' })).statusCode).toBe(404);
  });

  it('says what to do when VS Code is not on the PATH', async () => {
    await start(false);
    const res = await open();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/was not found on your PATH.*Install 'code' command/);
  });
});
