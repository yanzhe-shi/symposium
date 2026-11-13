import {
  asRecord,
  displayPath,
  firstString,
  parseJsonLine,
  toolEvent,
  type ToolKind,
} from './events.js';
import { runAntigravityAcp } from './antigravity-acp.js';
import { runProcess, runUnderPty, type ProcessOptions, type ProcessResult } from './process.js';
import {
  AdapterError,
  DEFAULT_TIMEOUT_MS,
  type AgentAccess,
  type AgentAdapter,
  type AgentEvent,
  type AgentReply,
  type AgentTask,
} from './types.js';

// The sandbox restricts terminal use; plan mode makes no edits.
const MODE_ARGS: Record<AgentAccess, string[]> = {
  edit: ['--mode', 'accept-edits', '--sandbox'],
  read: ['--mode', 'plan', '--sandbox'],
  none: ['--mode', 'plan', '--sandbox'],
};

interface AgyResult {
  status?: string;
  response?: string;
}

// Antigravity's model names can end in an effort, like `gemini-3.8-flash-low`.
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/** `agy` has no system prompt flag, so the system prompt goes at the top of the prompt. */
export function antigravityPrompt(task: AgentTask): string {
  return `${task.systemPrompt}\n\n---\n\n${task.prompt}`;
}

/** The model to ask for and the effort to set, given that some model names end in an effort. */
export function antigravityModel(task: AgentTask): { model: string; effort?: string } {
  const effort = task.effort && task.effort !== 'default' ? task.effort : undefined;
  // `agy` refuses an effort next to a model name that already carries one. The agent's effort
  // setting is the more specific choice, so it replaces the one in the name.
  return { model: effort ? task.model.replace(EFFORT_SUFFIX, '') : task.model, effort };
}

export function antigravityArgs(task: AgentTask): string[] {
  const prompt = antigravityPrompt(task);
  // One JSON object per line as the turn goes on, ending with the result.
  const args = ['-p', prompt, '--output-format', 'stream-json', ...MODE_ARGS[task.access]];
  const { model, effort } = antigravityModel(task);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/** `agy`'s tool names, by the kind of event they are reported as. */
export const KIND_BY_TOOL: Record<string, ToolKind> = {
  read_file: 'read',
  view_file: 'read',
  list_dir: 'read',
  write_file: 'edit',
  write_to_file: 'edit',
  edit_file: 'edit',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  sed_file: 'edit',
  notebook_edit: 'edit',
  grep_search: 'search',
  find_by_name: 'search',
  run_command: 'command',
  send_command_input: 'command',
};

/**
 * Turns the lines of `agy`'s `stream-json` output into progress events. Returns the function to
 * feed each line to. Every tool step arrives twice, as ACTIVE and as DONE: an edit is reported
 * when it is done, so "edited x" is true, and other tools the first time they are seen.
 */
export function antigravityEventReader(
  cwd: string,
  onEvent: (event: AgentEvent) => void,
): (line: string) => void {
  const reported = new Set<unknown>();
  return (text) => {
    const line = parseJsonLine(text);
    const step = line?.event === 'step_update' ? asRecord(line.step_update) : undefined;
    if (!step || step.step_type !== 'tool') return;
    const info = asRecord(step.tool_info);
    const tool = firstString(step, ['tool_name']) ?? firstString(info, ['name']) ?? 'a tool';
    const kind = KIND_BY_TOOL[tool] ?? 'tool';
    if (kind === 'edit' && step.state !== 'DONE') return;
    if (reported.has(step.step_index)) return;
    reported.add(step.step_index);

    // `Path` is the only parameter name known for sure. A search's path says where it looked,
    // not what for, so searches and commands are reported without a target.
    const path = firstString(asRecord(info?.parameters), ['Path']);
    const hasTarget = path !== undefined && kind !== 'search' && kind !== 'command';
    onEvent(toolEvent(kind, tool, hasTarget ? displayPath(path, cwd) : undefined));
  };
}

export interface AntigravityOutput {
  text: string;
  warning?: string;
}

function readResult(parsed: AgyResult): AntigravityOutput {
  const text = typeof parsed.response === 'string' ? parsed.response.trim() : '';
  if (!parsed.status || parsed.status === 'SUCCESS') return { text };
  // agy sometimes reports ERROR after finishing the work. Keep a real reply, flag the status.
  if (text !== '') return { text, warning: `Antigravity reported status ${parsed.status}` };
  throw new AdapterError(`Antigravity reported status ${parsed.status}`);
}

/**
 * Finds the reply in `agy`'s output: the `result` line of a `stream-json` stream, a single JSON
 * object as `--output-format json` prints, or plain text.
 */
export function parseAntigravityOutput(stdout: string): AntigravityOutput {
  const trimmed = stdout.trim();
  const events = trimmed
    .split('\n')
    .map(parseJsonLine)
    .filter((line) => line !== undefined)
    .filter((line) => typeof line.event === 'string');
  const result = asRecord(events.findLast((line) => line.event === 'result')?.result);
  if (result) return readResult(result as AgyResult);
  if (events.length > 0) {
    throw new AdapterError('agy stopped before giving a result', trimmed.slice(-2000));
  }

  // Under a terminal the CLI may print other text first, so read from the first '{'.
  const start = trimmed.indexOf('{');
  if (start !== -1) {
    try {
      return readResult(JSON.parse(trimmed.slice(start)) as AgyResult);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      // Not JSON after all; use the raw text below.
    }
  }
  return { text: trimmed };
}

/**
 * Runs the official `agy` CLI with the user's own login.
 *
 * A turn without terminal commands uses print mode, `agy -p`. That may print nothing when
 * stdout is not a TTY; then it is run again under a pseudo-terminal. Print mode cannot ask
 * before it runs a command, so a turn that may run commands goes through `agy acp` instead
 * (see antigravity-acp.ts).
 */
export class AntigravityAdapter implements AgentAdapter {
  readonly provider = 'antigravity' as const;

  constructor(private readonly command = 'agy') {}

  async run(task: AgentTask): Promise<AgentReply> {
    if (task.onCommand !== undefined && task.commands !== undefined && task.commands !== 'off') {
      return runAntigravityAcp(this.command, task);
    }
    const options: ProcessOptions = {
      command: this.command,
      args: antigravityArgs(task),
      cwd: task.workingDirectory,
      signal: task.signal,
      timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    const reader = task.onEvent && antigravityEventReader(task.workingDirectory, task.onEvent);
    let result: ProcessResult = await runProcess({ ...options, onStdoutLine: reader });
    if (result.exitCode === 0 && result.stdout.trim() === '') {
      result = await runUnderPty(options);
      // A terminal's output is only clean once it is complete, so progress is reported late.
      if (reader) result.stdout.split('\n').forEach(reader);
    }
    if (result.exitCode !== 0) {
      const details = (result.stderr || result.stdout).slice(0, 2000);
      if (details.includes('invalid model selection')) {
        throw new AdapterError(
          'Antigravity does not accept this model with this effort. Set the effort to Default or choose another model',
          details,
        );
      }
      throw new AdapterError(`agy exited with code ${result.exitCode}`, details);
    }
    const { text, warning } = parseAntigravityOutput(result.stdout);
    if (text === '') throw new AdapterError('agy returned an empty reply');
    return { text, warning, changedFiles: [] };
  }
}
