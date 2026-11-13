import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { AdapterError, CancelledError } from './types.js';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Written to stdin, which is then closed. Without it stdin is empty. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with each complete line of stdout as it arrives, for CLIs that stream progress. */
  onStdoutLine?: (line: string) => void;
  /**
   * For CLIs that are talked to while they run. Called once the process has started. Stdin
   * then stays open after `input` until the caller ends it.
   */
  onStart?: (stdin: ProcessStdin) => void;
}

/** The stdin of a running process. Writes after the process has gone are dropped. */
export interface ProcessStdin {
  write(text: string): void;
  end(): void;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

/** Runs a command without a shell and collects its output. Rejects on abort, timeout or spawn failure. */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const { command, args, cwd, input, env, signal, timeoutMs, onStdoutLine, onStart } = options;
  if (signal?.aborted) return Promise.reject(new CancelledError());

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function finish(error: Error | undefined, result?: ProcessResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    }

    function stop(): void {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS).unref();
    }

    function onAbort(): void {
      stop();
      finish(new CancelledError());
    }

    function collect(target: Buffer[]) {
      return (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          stop();
          finish(new AdapterError(`${command} produced more than ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
        target.push(chunk);
      };
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        stop();
        finish(new AdapterError(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }

    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    if (onStdoutLine) {
      // A chunk can end in the middle of a line, or of a character.
      const decoder = new StringDecoder('utf8');
      let partial = '';
      const feed = (text: string): void => {
        const lines = (partial + text).split('\n');
        partial = lines.pop()!;
        for (const line of lines) onStdoutLine(line.replace(/\r$/, ''));
      };
      child.stdout.on('data', (chunk: Buffer) => feed(decoder.write(chunk)));
      child.stdout.on('end', () => {
        feed(decoder.end());
        if (partial !== '') onStdoutLine(partial);
      });
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      const message =
        error.code === 'ENOENT'
          ? `Command not found: ${command}. Is it installed and on your PATH?`
          : `Could not start ${command}: ${error.message}`;
      finish(new AdapterError(message));
    });
    child.on('close', (exitCode) => {
      finish(undefined, {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
      });
    });

    child.stdin.on('error', () => {
      // The child may exit before reading stdin. Its exit code reports the real problem.
    });
    if (onStart) {
      if (input) child.stdin.write(input);
      onStart({
        write: (text) => {
          if (child.stdin.writable) child.stdin.write(text);
        },
        end: () => {
          if (child.stdin.writable) child.stdin.end();
        },
      });
    } else {
      child.stdin.end(input ?? '');
    }
  });
}

/** Whether `command` is an executable path or a name found on PATH. */
export async function commandExists(command: string, env = process.env): Promise<boolean> {
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? '').split(delimiter).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Try the next directory.
    }
  }
  return false;
}

// python3's pty module gives the child a terminal without a native Node dependency.
const PYTHON_PTY = [
  'import os, pty, sys',
  'status = pty.spawn(sys.argv[1:])',
  'sys.exit(os.waitstatus_to_exitcode(status))',
].join('\n');

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Runs a command under a pseudo-terminal, for CLIs that print nothing when stdout is a pipe.
 * Uses python3 if available, otherwise util-linux `script`.
 */
export async function runUnderPty(options: ProcessOptions): Promise<ProcessResult> {
  let result: ProcessResult;
  if (await commandExists('python3', options.env)) {
    result = await runProcess({
      ...options,
      command: 'python3',
      args: ['-c', PYTHON_PTY, options.command, ...options.args],
    });
  } else if (await commandExists('script', options.env)) {
    const commandLine = [options.command, ...options.args].map(shellQuote).join(' ');
    result = await runProcess({
      ...options,
      command: 'script',
      args: ['-qec', commandLine, '/dev/null'],
    });
  } else {
    throw new AdapterError(
      `${options.command} printed nothing, and running it in a terminal needs python3 or script`,
    );
  }
  return { ...result, stdout: cleanTerminalOutput(result.stdout) };
}

/** Removes ANSI escape sequences and carriage returns added by a terminal. */
export function cleanTerminalOutput(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]/g, '')
      .replace(/\r/g, '')
  );
}
