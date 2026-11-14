import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { commandExists } from '@symposium/adapters';
import { loadConfig, type EngineConfig } from './config.js';
import { startEngine } from './start.js';

export const HELP = `Symposium: a group chat where you run a software project with a team of AI agents.

Usage:
  symposium              Start Symposium and open it in your browser
  symposium stop         Stop a Symposium that is running
  symposium status       Say whether Symposium is running

Options:
  --port <number>        Use another port (default 4400, or SYMPOSIUM_PORT)
  --no-open              Start without opening the browser
  -h, --help             Show this help

Your data is kept in ~/.symposium (or SYMPOSIUM_HOME). New projects go in ~/symposium-projects.`;

export type LauncherCommand = 'start' | 'stop' | 'status' | 'help';

export interface LauncherArgs {
  command: LauncherCommand;
  port?: number;
  open: boolean;
}

/** Reads the command line. Throws an Error with a message for the user when it makes no sense. */
export function parseArgs(argv: readonly string[]): LauncherArgs {
  const args: LauncherArgs = { command: 'start', open: true };
  let named = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help' || arg === 'help') args.command = 'help';
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length);
      const port = Number(value);
      if (!value || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('--port needs a number between 1 and 65535');
      }
      args.port = port;
    } else if ((arg === 'start' || arg === 'stop' || arg === 'status') && !named) {
      args.command = arg;
      named = true;
    } else {
      throw new Error(`Unknown option "${arg}". Run "symposium --help" to see what there is.`);
    }
  }
  return args;
}

/** The programs that can open a web page here, best first. The first one found is used. */
export function browserCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): [string, string[]][] {
  if (platform === 'darwin') return [['open', [url]]];
  if (platform === 'win32') return [['cmd', ['/c', 'start', '', url]]];
  const linux: [string, string[]][] = [['xdg-open', [url]]];
  // Inside WSL the browser is on the Windows side.
  if (env.WSL_DISTRO_NAME) return [['wslview', [url]], ['explorer.exe', [url]], ...linux];
  return linux;
}

/** Opens the page in the browser. Returns false when no way to do so was found. */
export async function openBrowser(url: string): Promise<boolean> {
  for (const [command, args] of browserCommands(url)) {
    if (process.platform !== 'win32' && !(await commandExists(command))) continue;
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  }
  return false;
}

const pidFile = (config: EngineConfig): string => join(config.dataDir, 'engine.pid');

/** The address people open. `localhost` reads better than 127.0.0.1 and is the same place. */
const pageUrl = (port: number): string => `http://localhost:${port}`;

/** Whether a Symposium engine answers on this port. */
export async function isRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok && ((await res.json()) as { status?: string }).status === 'ok';
  } catch {
    return false;
  }
}

/** The running engine's process id and port, as it wrote them down when it started. */
function readPidFile(config: EngineConfig): { pid: number; port: number } | undefined {
  try {
    const saved = JSON.parse(readFileSync(pidFile(config), 'utf8')) as {
      pid?: unknown;
      port?: unknown;
    };
    return typeof saved.pid === 'number' && typeof saved.port === 'number'
      ? { pid: saved.pid, port: saved.port }
      : undefined;
  } catch {
    return undefined;
  }
}

async function start(
  config: EngineConfig,
  open: boolean,
  say: (line: string) => void,
): Promise<number> {
  const url = pageUrl(config.port);
  if (await isRunning(config.port)) {
    say(`Symposium is already running at ${url}`);
    if (open) await openBrowser(url);
    return 0;
  }
  if (!existsSync(join(config.uiDir, 'index.html'))) {
    say(
      'The chat page has not been built yet. In the Symposium folder, run:\n\n  pnpm install\n  pnpm build\n\nor run scripts/install.sh, which does both.',
    );
    return 1;
  }

  let engine;
  try {
    // Quiet: warnings and errors only. `pnpm dev` shows every request.
    engine = await startEngine(config, { level: 'warn' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      say(
        `Port ${config.port} is used by another program. Try: symposium --port ${config.port + 1}`,
      );
      return 1;
    }
    throw error;
  }
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(pidFile(config), JSON.stringify({ pid: process.pid, port: config.port }));

  say(`Symposium is running at ${url}`);
  say('Press Ctrl+C here, or run "symposium stop", to stop it.');
  if (open && !(await openBrowser(url))) say('Open that address in your browser.');

  return new Promise((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      say('\nStopping Symposium…');
      void engine
        .stop()
        .catch(() => undefined)
        .then(() => {
          rmSync(pidFile(config), { force: true });
          resolve(0);
        });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function stop(config: EngineConfig, say: (line: string) => void): Promise<number> {
  const saved = readPidFile(config);
  // The pid is trusted only while an engine answers on the port it wrote down with it.
  if (!saved || !(await isRunning(saved.port))) {
    rmSync(pidFile(config), { force: true });
    say('Symposium is not running.');
    return 0;
  }
  process.kill(saved.pid, 'SIGTERM');
  for (let tries = 0; tries < 100; tries += 1) {
    if (!(await isRunning(saved.port))) {
      say('Symposium stopped.');
      return 0;
    }
    await sleep(100);
  }
  say(`Symposium (process ${saved.pid}) did not stop in time.`);
  return 1;
}

/** Runs the `symposium` command. Returns the exit code. */
export async function runLauncher(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  say: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  let args: LauncherArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    say((error as Error).message);
    return 2;
  }
  if (args.command === 'help') {
    say(HELP);
    return 0;
  }
  const config = loadConfig(args.port ? { ...env, SYMPOSIUM_PORT: String(args.port) } : env);
  if (args.command === 'stop') return stop(config, say);
  if (args.command === 'status') {
    const port = args.port ?? readPidFile(config)?.port ?? config.port;
    const running = await isRunning(port);
    say(running ? `Symposium is running at ${pageUrl(port)}` : 'Symposium is not running.');
    return running ? 0 : 1;
  }
  return start(config, args.open, say);
}
