import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProcess } from './process.js';
import { PROVIDER_STATE, bwrapArgs, sandboxAvailable, type Sandbox } from './sandbox.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symposium-sandbox-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Makes a folder under the test's own folder and returns its path. */
function folder(...parts: string[]): string {
  const path = join(dir, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function file(text: string, ...parts: string[]): string {
  const path = join(dir, ...parts);
  writeFileSync(path, text);
  return path;
}

describe('bwrapArgs', () => {
  /** The mounts among the arguments, as `flag path`, in order. */
  async function mounts(sandbox: Sandbox, cwd: string): Promise<string[]> {
    const args = await bwrapArgs(sandbox, cwd);
    const found: string[] = [];
    args.forEach((arg, index) => {
      if (arg === '--tmpfs') found.push(`--tmpfs ${args[index + 1]}`);
      if (arg === '--bind' || arg === '--ro-bind' || arg === '--dev-bind') {
        found.push(`${arg} ${args[index + 1]} ${args[index + 2]}`);
      }
    });
    return found
      .map((mount) => mount.replaceAll(dir, ''))
      .filter((mount) => mount !== '--ro-bind / /');
  }

  it('shows the whole disk read-only and ends where the command goes', async () => {
    const work = folder('work');
    const args = await bwrapArgs({ writable: [work], readOnly: [], hidden: [] }, work);
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--new-session');
    expect(args.slice(-3)).toEqual(['--chdir', work, '--']);
  });

  it('mounts a folder before what lies inside it, whatever the kind', async () => {
    const sandbox: Sandbox = {
      // A worktree inside a hidden data folder, and a login folder with a hidden part.
      writable: [folder('data', 'worktrees', 'ada'), folder('login')],
      readOnly: [file('{}', 'login', 'settings.json')],
      hidden: [folder('data'), folder('login', 'sessions')],
    };
    expect(await mounts(sandbox, dir)).toEqual([
      '--bind /login /login',
      '--tmpfs /data',
      '--ro-bind /login/settings.json /login/settings.json',
      '--tmpfs /login/sessions',
      '--bind /data/worktrees/ada /data/worktrees/ada',
    ]);
  });

  it('leaves out what is not there, and hides a file behind the null device', async () => {
    const sandbox: Sandbox = {
      writable: [join(dir, 'missing')],
      readOnly: [join(dir, 'also-missing')],
      hidden: [file('token', 'netrc'), join(dir, 'no-such-folder')],
    };
    expect(await mounts(sandbox, dir)).toEqual(['--dev-bind /dev/null /netrc']);
  });

  it('names where each provider keeps its login', () => {
    expect(PROVIDER_STATE['claude-code'].writable).toEqual(['.claude', '.claude.json']);
    expect(PROVIDER_STATE.antigravity.writable).toEqual(['.gemini']);
    expect(PROVIDER_STATE.mock.writable).toEqual([]);
  });
});

// The real thing. Some systems and most containers do not allow bubblewrap: skipped there.
describe.skipIf(!(await sandboxAvailable()))('a process in the sandbox', () => {
  /** Runs a shell script in the sandbox, in the worktree. Returns its output lines. */
  async function run(sandbox: Sandbox, script: string): Promise<string[]> {
    const result = await runProcess({
      command: 'sh',
      args: ['-c', script],
      cwd: sandbox.writable[0] ?? dir,
      sandbox,
      timeoutMs: 20_000,
    });
    return (result.stdout + result.stderr).trim().split('\n');
  }

  it('writes in its own folder and nowhere else', async () => {
    const worktree = folder('data', 'worktrees', 'ada');
    const project = folder('project');
    file('the plan\n', 'project', 'plan.md');
    const out = await run(
      // The data folder is hidden, the worktree inside it is not.
      { writable: [worktree], readOnly: [project], hidden: [folder('data'), tmpdir()] },
      `echo mine > mine.txt && echo "wrote mine"
       { echo x > ${project}/theirs.txt; } 2>/dev/null || echo "project refused"
       { echo x > "$HOME/symposium-sandbox-test.txt"; } 2>/dev/null || echo "home refused"
       cat ${project}/plan.md
       pwd`,
    );
    expect(out).toEqual(['wrote mine', 'project refused', 'home refused', 'the plan', worktree]);
    expect(readFileSync(join(worktree, 'mine.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(project, 'theirs.txt'))).toBe(false);
  });

  it('sees hidden folders and files empty, and what it writes there is gone afterwards', async () => {
    const worktree = folder('worktree');
    const secrets = folder('secrets');
    file('key', 'secrets', 'id_ed25519');
    const token = file('token', 'netrc');
    const out = await run(
      { writable: [worktree], readOnly: [], hidden: [secrets, token] },
      `ls ${secrets} | wc -l
       wc -c < ${token}
       echo planted > ${secrets}/planted && echo "wrote into the empty folder"`,
    );
    expect(out).toEqual(['0', '0', 'wrote into the empty folder']);
    expect(existsSync(join(secrets, 'planted'))).toBe(false);
    expect(readFileSync(token, 'utf8')).toBe('token');
  });

  it('keeps a read-only file inside a writable folder as it is', async () => {
    const login = folder('login');
    const settings = file('{}', 'login', 'settings.json');
    const out = await run(
      { writable: [login], readOnly: [settings], hidden: [] },
      `echo refreshed > credentials && echo "login written"
       { echo hooks > settings.json; } 2>/dev/null || echo "settings refused"`,
    );
    expect(out).toEqual(['login written', 'settings refused']);
    expect(readFileSync(settings, 'utf8')).toBe('{}');
  });

  it('cannot see the processes outside', async () => {
    const out = await run(
      { writable: [folder('w')], readOnly: [], hidden: [] },
      'ls /proc | grep -c "^[0-9]"',
    );
    // bubblewrap itself, the shell, and the two commands of the pipe at most.
    expect(Number(out[0])).toBeLessThan(6);
  });

  it('is stopped with everything it started', async () => {
    const worktree = folder('w');
    const controller = new AbortController();
    const running = runProcess({
      command: 'sh',
      args: ['-c', '(sleep 2; echo late > late.txt) & echo started; wait'],
      cwd: worktree,
      sandbox: { writable: [worktree], readOnly: [], hidden: [] },
      signal: controller.signal,
      onStdoutLine: () => controller.abort(),
    });
    await expect(running).rejects.toThrow('Cancelled');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(join(worktree, 'late.txt'))).toBe(false);
  });
});
