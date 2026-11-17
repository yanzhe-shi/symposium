import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProcess } from './process.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PROVIDER_STATE,
  bwrapArgs,
  pastaArgs,
  privateNetworkAvailable,
  sandboxAvailable,
  sessionBusPath,
  type Sandbox,
} from './sandbox.js';

// The session bus filter needs a desktop session and xdg-dbus-proxy.
const canFilterBus = await sandboxAvailable('antigravity');
// A network of its own needs pasta (package passt).
const canIsolateNetwork = await privateNetworkAvailable();

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

  it('lets a private network reach only the ports named, and shows nothing of it outside', () => {
    const args = pastaArgs([]);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect([value('-T'), value('-U'), value('-t'), value('-u')]).toEqual([
      'none',
      'none',
      'none',
      'none',
    ]);
    expect(args).toContain('--no-map-gw');
    expect(args.at(-1)).toBe('--');
    expect(pastaArgs([5432, 6379])[pastaArgs([]).indexOf('-T') + 1]).toBe('5432,6379');
  });

  it('names where each provider keeps its login', () => {
    expect(PROVIDER_STATE['claude-code'].writable).toEqual(['.claude', '.claude.json']);
    expect(PROVIDER_STATE.antigravity.writable).toEqual(['.gemini']);
    expect(PROVIDER_STATE.antigravity.sessionBus).toEqual(['org.freedesktop.secrets']);
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

  describe.skipIf(!canIsolateNetwork)('with a network of its own', () => {
    let servers: Server[] = [];
    afterEach(() => {
      servers.forEach((server) => server.close());
      servers = [];
    });

    /** A server on this computer's localhost, on a free port. Returns the port. */
    async function hostServer(): Promise<number> {
      const server = createServer((_request, response) => response.end('host'));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    }

    const reach = (port: number) =>
      `node -e "fetch('http://127.0.0.1:${port}/').then(() => console.log('${port} reached'), () => console.log('${port} refused'))"`;

    it('reaches no program on this computer but the ports named', async () => {
      const [named, other] = [await hostServer(), await hostServer()];
      const out = await run(
        { writable: [folder('w')], readOnly: [], hidden: [], network: { hostPorts: [named] } },
        `${reach(named)}; ${reach(other)}`,
      );
      expect(out).toEqual([`${named} reached`, `${other} refused`]);
    });

    it('has a localhost of its own, for a project whose tests start a server', async () => {
      const out = await run(
        { writable: [folder('w')], readOnly: [], hidden: [], network: { hostPorts: [] } },
        `node -e "const s = require('http').createServer((q, r) => r.end('inside')).listen(0, '127.0.0.1', () =>
           fetch('http://127.0.0.1:' + s.address().port + '/').then((r) => r.text()).then((t) => { console.log(t); s.close(); }))"`,
      );
      expect(out).toEqual(['inside']);
    });

    it('keeps stdin open for a conversation, and passes the exit code and stderr on', async () => {
      const worktree = folder('w');
      let stdin: { write(text: string): void; end(): void } | undefined;
      const lines: string[] = [];
      const result = await runProcess({
        command: 'sh',
        args: ['-c', 'while read line; do echo "got $line"; done; echo done >&2; exit 3'],
        cwd: worktree,
        sandbox: { writable: [worktree], readOnly: [], hidden: [], network: { hostPorts: [] } },
        timeoutMs: 20_000,
        onStart: (opened) => {
          stdin = opened;
          opened.write('one\n');
        },
        onStdoutLine: (line) => {
          lines.push(line);
          if (line === 'got one') stdin!.write('two\n');
          if (line === 'got two') stdin!.end();
        },
      });
      expect(lines).toEqual(['got one', 'got two']);
      expect(result).toMatchObject({ exitCode: 3, stderr: 'done\n' });
    });

    it('ends a pipe as a shell does, without complaint', async () => {
      const out = await run(
        { writable: [folder('w')], readOnly: [], hidden: [], network: { hostPorts: [] } },
        'yes | head -n 1',
      );
      expect(out).toEqual(['y']);
    });

    it('is stopped with everything it started', async () => {
      const worktree = folder('w');
      const controller = new AbortController();
      const running = runProcess({
        command: 'sh',
        args: ['-c', '(sleep 2; echo late > late.txt) & echo started; wait'],
        cwd: worktree,
        sandbox: { writable: [worktree], readOnly: [], hidden: [], network: { hostPorts: [] } },
        signal: controller.signal,
        onStdoutLine: () => controller.abort(),
      });
      await expect(running).rejects.toThrow('Cancelled');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(existsSync(join(worktree, 'late.txt'))).toBe(false);
    });
  });

  // Needs a desktop session and xdg-dbus-proxy as well.
  it.skipIf(!canFilterBus)(
    'reaches the session bus only through a filter, which goes when the process ends',
    async () => {
      const bus = sessionBusPath()!;
      const runtime = dirname(bus);
      const out = await run(
        {
          writable: [folder('w')],
          readOnly: [],
          hidden: [runtime],
          sessionBus: ['org.example.Keys'],
        },
        `ls ${runtime}
         test -S ${bus} && echo "a socket"
         stat -c %i ${bus}`,
      );
      // Of everything in the session's folder, only the bus is there, and it is not the real one.
      expect(out.slice(0, 2)).toEqual(['bus', 'a socket']);
      expect(out[2]).not.toBe(String(statSync(bus).ino));
      await vi.waitFor(() =>
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith('symposium-bus-'))).toEqual(
          [],
        ),
      );
    },
  );
});
