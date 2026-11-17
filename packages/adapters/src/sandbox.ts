import { execFile, spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { commandExists } from './process.js';
import { AdapterError, type ProviderId } from './types.js';

/**
 * What a provider's process may touch during one turn, enforced by the kernel and not by the
 * provider. The engine decides it; an adapter only passes it on to `runProcess`.
 *
 * The process sees the whole disk read-only, except:
 * - `writable`: files and folders it may change, such as the agent's worktree.
 * - `hidden`: files and folders it sees empty, such as `~/.ssh`. What it writes there is
 *   thrown away with the turn.
 * - `readOnly`: files and folders it may read but not change, where they lie inside one of the
 *   above.
 *
 * Where two of them nest, the deeper path wins. Paths that do not exist are left out.
 *
 * `sessionBus` names the services of the user's desktop session (D-Bus) it may talk to, such
 * as the keyring a CLI keeps its login in. It reaches those and no others, through a filter.
 *
 * `network` says what it may reach over the network. See `SandboxNetwork`. Without it, the
 * computer's own network.
 */
export interface Sandbox {
  writable: string[];
  readOnly: string[];
  hidden: string[];
  sessionBus?: string[];
  network?: SandboxNetwork;
}

/**
 * - `'host'`: the computer's own network. The process reaches the internet and every program
 *   that listens on this computer, Symposium's own API included.
 * - `{ hostPorts }`: a network of its own (made with `pasta`) that reaches the internet and,
 *   of this computer, only these TCP ports on localhost. Its own localhost works as usual, so
 *   a project's tests can start a server and call it.
 */
export type SandboxNetwork = 'host' | { hostPorts: number[] };

/**
 * The files a provider's CLI keeps under the user's home, as paths relative to it. The CLI
 * must be able to write its login and caches. Its settings stay read-only, so that an agent
 * cannot plant something there for the user's own next session, and its records of the user's
 * other sessions are hidden.
 */
export const PROVIDER_STATE: Record<ProviderId, Sandbox> = {
  'claude-code': {
    writable: ['.claude', '.claude.json'],
    readOnly: [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/CLAUDE.md',
      '.claude/agents',
      '.claude/commands',
      '.claude/hooks',
      '.claude/plugins',
      '.claude/skills',
    ],
    hidden: [
      '.claude/file-history',
      '.claude/history.jsonl',
      '.claude/plans',
      '.claude/projects',
      '.claude/sessions',
      '.claude/shell-snapshots',
    ],
  },
  // agy keeps its login in the desktop keyring, which it asks for over the session bus.
  antigravity: {
    writable: ['.gemini'],
    readOnly: [],
    hidden: [],
    sessionBus: ['org.freedesktop.secrets'],
  },
  'openai-compatible': { writable: [], readOnly: [], hidden: [] },
  mock: { writable: [], readOnly: [], hidden: [] },
};

type MountKind = 'writable' | 'readOnly' | 'hidden';

interface Mount {
  /** Where it appears inside the sandbox. */
  path: string;
  args: string[];
}

/** One path of the sandbox as a mount, with links followed. Undefined when nothing is there. */
async function mount(kind: MountKind, wanted: string): Promise<Mount | undefined> {
  try {
    const path = await realpath(wanted);
    if (kind === 'writable') return { path, args: ['--bind', path, path] };
    if (kind === 'readOnly') return { path, args: ['--ro-bind', path, path] };
    // An empty folder in memory, or the null device in place of a file.
    const isFile = !(await stat(path)).isDirectory();
    return { path, args: isFile ? ['--dev-bind', '/dev/null', path] : ['--tmpfs', path] };
  } catch {
    return undefined;
  }
}

function depth(path: string): number {
  return path.split(sep).filter(Boolean).length;
}

/**
 * The `bwrap` (bubblewrap) arguments that confine a command to `sandbox`. The command itself
 * and its own arguments follow them. `extra` are mounts made for this one run.
 */
export async function bwrapArgs(
  sandbox: Sandbox,
  cwd: string,
  extra: Mount[] = [],
): Promise<string[]> {
  const found = await Promise.all(
    (['writable', 'readOnly', 'hidden'] as const).flatMap((kind) =>
      sandbox[kind].map((path) => mount(kind, path)),
    ),
  );
  // A folder is mounted before what lies inside it, so the deeper path has the last word.
  const mounts = [...found.filter((made) => made !== undefined), ...extra].sort(
    (a, b) => depth(a.path) - depth(b.path),
  );
  return [...BASE_ARGS, ...mounts.flatMap((made) => made.args), '--chdir', cwd, '--'];
}

const BASE_ARGS = [
  // The whole disk, read-only, with fresh /dev and /proc.
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  // Its own process list: it cannot see or signal anything outside.
  '--unshare-pid',
  // No way to type into the terminal Symposium was started from.
  '--new-session',
  '--die-with-parent',
];

/** A sandbox made ready for one process. `close` when the process has ended. */
export interface OpenSandbox {
  /**
   * What runs in place of the command: `bwrap …`, or `pasta … -- bwrap …` with a network of
   * its own. The command and its own arguments follow.
   */
  prefix: string[];
  close(): void;
}

/**
 * Gets `sandbox` ready for one process: its mounts and, if it needs them, its session bus
 * filter and its own network.
 */
export async function openSandbox(sandbox: Sandbox, cwd: string): Promise<OpenSandbox> {
  const closers: (() => void)[] = [];
  const close = (): void => closers.forEach((closeOne) => closeOne());
  try {
    const extra: Mount[] = [];
    if (sandbox.sessionBus?.length) {
      const bus = await openSessionBus(sandbox.sessionBus);
      closers.push(bus.close);
      extra.push(bus.mount);
    }
    const network = sandbox.network ?? 'host';
    if (network !== 'host') {
      const resolver = await privateResolver();
      closers.push(resolver.close);
      if (resolver.mount) extra.push(resolver.mount);
    }
    const bwrap = ['bwrap', ...(await bwrapArgs(sandbox, cwd, extra))];
    const prefix =
      network === 'host' ? bwrap : [...pastaPrefix(network.hostPorts), ...bwrap, ...UNDO_PASTA];
    return { prefix, close };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * The address the private network asks for names. `pasta` passes those questions on to the
 * computer's own resolver, which may listen on its localhost (systemd-resolved does).
 */
const PRIVATE_DNS = '169.254.1.53';

/**
 * pasta turns a standard input or output that is a socket into `/dev/null`, and Node gives a
 * child sockets. So a small bash script runs first: it puts pipes in their place, with a `cat`
 * on the other end of each, and then becomes pasta. The process keeps its id, its exit code and
 * its process group, and each `cat` ends when its pipe does.
 */
const PIPES_FOR_PASTA =
  'exec 3>&1 4>&2; exec "$@" < <(exec cat 2>/dev/null 3>&- 4>&-) > >(exec cat 4>&-) 2> >(exec cat >&4 3>&-)';

/**
 * pasta leaves its child with SIGPIPE ignored, which makes `yes | head` and its like complain
 * of a broken pipe. This puts it back for the command, after `bwrap`.
 */
const UNDO_PASTA = ['env', '--default-signal=PIPE'];

/**
 * What goes in front of `bwrap` to give a process a network of its own: the pipes, then
 * `pasta`. `bwrap` and the command follow.
 */
export function pastaPrefix(hostPorts: number[]): string[] {
  return ['bash', '-c', PIPES_FOR_PASTA, 'symposium-sandbox', 'pasta', ...pastaArgs(hostPorts)];
}

/**
 * The `pasta` arguments.
 *
 * - `-T` names the localhost ports of this computer the process may reach; `none` for none.
 *   Without it, pasta lets the process reach every one.
 * - `-U none`: no UDP ports of this computer either.
 * - `-t none -u none`: nothing the process listens on shows up on this computer.
 * - `--no-map-gw`: the gateway address does not lead to this computer.
 */
export function pastaArgs(hostPorts: number[]): string[] {
  const ports = hostPorts.length ? hostPorts.join(',') : 'none';
  return [
    '--config-net',
    '--no-map-gw',
    '--quiet',
    '-T',
    ports,
    '-U',
    'none',
    '-t',
    'none',
    '-u',
    'none',
    '--dns-forward',
    PRIVATE_DNS,
    '--',
  ];
}

/**
 * A `resolv.conf` for the private network, mounted over the computer's own, which may name a
 * resolver on localhost that the private network cannot reach.
 */
async function privateResolver(): Promise<{ mount?: Mount; close: () => void }> {
  let target: string;
  try {
    target = await realpath('/etc/resolv.conf');
  } catch {
    return { close: () => {} };
  }
  const folder = await mkdtemp(join(tmpdir(), 'symposium-net-'));
  const close = (): void => void rm(folder, { recursive: true, force: true });
  try {
    const file = join(folder, 'resolv.conf');
    await writeFile(file, `nameserver ${PRIVATE_DNS}\n`);
    return { mount: { path: target, args: ['--ro-bind', file, target] }, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** Where the user's session bus listens, if it is a socket file. */
export function sessionBusPath(env = process.env): string | undefined {
  return /^unix:path=([^,;]+)/.exec(env.DBUS_SESSION_BUS_ADDRESS ?? '')?.[1];
}

const BUS_PROXY = 'xdg-dbus-proxy';
const BUS_PROXY_START_MS = 5000;

/**
 * Starts a filter in front of the session bus that lets through only talk with `names`. The
 * sandbox gets the filter's socket in the place of the real one. Without it a process could
 * ask the session to start any program, outside the sandbox.
 */
async function openSessionBus(names: string[]): Promise<{ mount: Mount; close: () => void }> {
  const busPath = sessionBusPath();
  if (!busPath) throw new AdapterError('The sandbox needs the session bus, and there is none.');
  const folder = await mkdtemp(join(tmpdir(), 'symposium-bus-'));
  const socket = join(folder, 'bus');
  // The proxy writes to file descriptor 3 once it listens, and ends when that pipe closes: so
  // it also goes when Symposium does.
  const proxy = spawn(
    BUS_PROXY,
    [
      `unix:path=${busPath}`,
      socket,
      '--fd=3',
      '--filter',
      ...names.map((name) => `--talk=${name}`),
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
  );
  const close = (): void => {
    proxy.kill();
    void rm(folder, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (why: string) => reject(new AdapterError(`${BUS_PROXY} ${why}`));
      const timer = setTimeout(() => failed('did not start in time'), BUS_PROXY_START_MS);
      proxy.stdio[3]!.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      proxy.once('error', (error) => failed(`could not start: ${error.message}`));
      proxy.once('exit', (code) => failed(`ended at once (exit code ${code})`));
    });
  } catch (error) {
    close();
    throw error;
  }
  return { mount: { path: busPath, args: ['--bind', socket, busPath] }, close };
}

let probe: Promise<boolean> | undefined;

/** Whether `bwrap` is here and allowed to work. Some systems and most containers forbid it. */
function bwrapWorks(): Promise<boolean> {
  probe ??= new Promise((resolve) => {
    if (process.platform !== 'linux') return resolve(false);
    execFile('bwrap', [...BASE_ARGS, '--', 'true'], { timeout: 10_000 }, (error) =>
      resolve(error === null),
    );
  });
  return probe;
}

let networkProbe: Promise<boolean> | undefined;

/**
 * Whether this computer can give a sandboxed process a network of its own: `pasta` (package
 * `passt`) is here and works. Where it is not, sandboxed processes use the computer's own.
 */
export async function privateNetworkAvailable(): Promise<boolean> {
  if (!(await bwrapWorks())) return false;
  networkProbe ??= new Promise((resolve) => {
    const [program, ...args] = [
      ...pastaPrefix([]),
      'bwrap',
      ...BASE_ARGS,
      '--',
      ...UNDO_PASTA,
      'true',
    ];
    execFile(program!, args, { timeout: 10_000 }, (error) => resolve(error === null));
  });
  return networkProbe;
}

/**
 * Whether this computer can sandbox a process: Linux with a working `bwrap`. With a
 * `provider`: whether it can sandbox that provider's CLI, which may need the session bus
 * filter as well.
 */
export async function sandboxAvailable(provider?: ProviderId): Promise<boolean> {
  if (!(await bwrapWorks())) return false;
  if (!provider || !PROVIDER_STATE[provider].sessionBus?.length) return true;
  return sessionBusPath() !== undefined && (await commandExists(BUS_PROXY));
}
