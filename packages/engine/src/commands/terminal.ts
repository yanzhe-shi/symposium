import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { uncommittedChanges } from '../git/workspaces.js';
import type { Agent, Group, TerminalRun } from '../protocol.js';
import { logEvent } from '../store/events.js';

export const MAX_COMMAND_LENGTH = 4000;
/** Output past this is not forwarded, so a runaway command cannot flood the page. */
export const MAX_TERMINAL_OUTPUT = 1024 * 1024;
export const MAX_RUNS_PER_GROUP = 4;
const DEFAULT_TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 2000;

/** The folder a command runs in. `agent` is set when it is that agent's worktree. */
export interface TerminalFolder {
  path: string;
  /** In words: "the project folder", "Ada's worktree". */
  label: string;
  agent?: Agent;
}

interface Run extends TerminalRun {
  groupId: string;
  child: ChildProcess;
  /** Settles when the command has ended and its end has been recorded. */
  done: Promise<void>;
}

/**
 * The human's own terminal in the Code tab. The human types the command and starts it, so
 * there is nothing to approve: it runs as it would if they typed it in their own shell, in the
 * folder they chose. Agents cannot reach this; their commands go through CommandApprovals.
 *
 * A plain process with no terminal emulation. Output streams to the page, and every run is
 * logged.
 */
export class HumanTerminal {
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly ctx: AppContext,
    private readonly timeoutMs = DEFAULT_TERMINAL_TIMEOUT_MS,
  ) {}

  start(group: Group, where: string, folder: TerminalFolder, command: string): TerminalRun {
    if (command.trim() === '') throw badRequest('Type a command to run');
    if (!existsSync(folder.path)) throw notFound(`${folder.label} does not exist yet`);
    const running = [...this.runs.values()].filter((run) => run.groupId === group.id);
    if (running.length >= MAX_RUNS_PER_GROUP) {
      throw conflict('Too many commands are running. Stop one or wait for it to finish.');
    }

    const runId = randomUUID();
    // Its own process group, so Stop also reaches whatever the command started.
    const child = spawn('sh', ['-c', command], {
      cwd: folder.path,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const run: Run = {
      runId,
      where,
      folder: folder.label,
      command,
      groupId: group.id,
      child,
      done,
    };
    this.runs.set(runId, run);
    const started = Date.now();
    let sent = 0;

    const forward = (chunk: Buffer): void => {
      if (sent >= MAX_TERMINAL_OUTPUT) return;
      const text = chunk.toString('utf8').slice(0, MAX_TERMINAL_OUTPUT - sent);
      sent += text.length;
      const note = sent >= MAX_TERMINAL_OUTPUT ? '\n… output cut off here\n' : '';
      this.ctx.hub.broadcast(group.id, { type: 'terminal.output', runId, text: text + note });
    };
    child.stdout!.on('data', forward);
    child.stderr!.on('data', forward);

    const timer = setTimeout(() => this.kill(run), this.timeoutMs);
    timer.unref();
    let ended = false;
    const end = (exitCode: number | null, problem?: string): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      this.runs.delete(runId);
      if (problem) {
        this.ctx.hub.broadcast(group.id, { type: 'terminal.output', runId, text: problem });
      }
      logEvent(this.ctx.db, {
        groupId: group.id,
        agentId: folder.agent?.id,
        kind: 'human.command',
        detail: { command, folder: folder.label, exitCode, durationMs: Date.now() - started },
      });
      this.ctx.hub.broadcast(group.id, { type: 'terminal.exit', runId, exitCode });
      this.refreshLiveChanges(group, folder);
      finished();
    };
    child.on('error', (error) => end(null, `Could not start the command: ${error.message}\n`));
    child.on('close', (code) => end(code));

    return { runId, where, folder: folder.label, command };
  }

  /** Stops a running command. Returns whether there was one. */
  stop(groupId: string, runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.groupId !== groupId) return false;
    this.kill(run);
    return true;
  }

  /** Stops everything and waits until it has ended. Called when the server shuts down. */
  async shutdown(): Promise<void> {
    const running = [...this.runs.values()];
    for (const run of running) this.kill(run);
    await Promise.all(running.map((run) => run.done));
  }

  /** A command in a worktree may have changed what that agent's live view shows. */
  private refreshLiveChanges(group: Group, folder: TerminalFolder): void {
    const agent = folder.agent;
    if (!agent) return;
    void uncommittedChanges(folder.path)
      .then((changes) =>
        this.ctx.hub.broadcast(group.id, { type: 'worktree.changed', agentId: agent.id, changes }),
      )
      .catch(() => undefined);
  }

  private kill(run: Run): void {
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (run.child.pid !== undefined) process.kill(-run.child.pid, name);
      } catch {
        // Already gone.
      }
    };
    signal('SIGTERM');
    setTimeout(() => {
      if (this.runs.has(run.runId)) signal('SIGKILL');
    }, KILL_GRACE_MS).unref();
  }
}
