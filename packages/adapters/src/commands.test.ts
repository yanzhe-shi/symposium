import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter } from './antigravity.js';
import { ClaudeCodeAdapter, claudeCodeArgs, offersCommands } from './claude-code.js';
import { MockAdapter } from './mock.js';
import { sandboxAvailable } from './sandbox.js';
import type { AgentEvent, AgentTask, CommandDecision, CommandRequest } from './types.js';

// Some systems and most containers do not allow bubblewrap.
const canSandbox = await sandboxAvailable();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symposium-commands-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Recorded {
  events: AgentEvent[];
  asked: CommandRequest[];
}

/** A task with a terminal whose commands are answered by `answer`. */
function task(
  answer: (request: CommandRequest) => CommandDecision | Promise<CommandDecision>,
  overrides: Partial<AgentTask> = {},
): AgentTask & Recorded {
  const events: AgentEvent[] = [];
  const asked: CommandRequest[] = [];
  return {
    agentName: 'Ada',
    model: 'test-model',
    systemPrompt: 'You are Ada.',
    prompt: 'Please run the tests.',
    trigger: 'Please run the tests.',
    workingDirectory: dir,
    access: 'edit',
    commands: 'ask',
    onCommand: async (request) => {
      asked.push(request);
      return answer(request);
    },
    onEvent: (event) => events.push(event),
    events,
    asked,
    ...overrides,
  };
}

const summaries = (recorded: Recorded) =>
  recorded.events.map((event) => `${event.kind}: ${event.summary}`);

/** Writes an executable Node script and returns its path. */
function fakeNodeCli(name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(path, 0o755);
  return path;
}

// Shared by both fake CLIs: read JSON lines from stdin, write JSON lines to stdout, and keep a
// copy of everything received so a test can look at it.
const LINE_IO = `
const fs = require('node:fs');
const received = [];
const out = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    received.push(message);
    fs.writeFileSync(process.env.RECEIVED_FILE, JSON.stringify(received));
    onMessage(message);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

describe('MockAdapter commands', () => {
  it('asks before each scripted command and reports how it went', async () => {
    const mock = new MockAdapter([{ text: 'done', commands: ['npm test', 'git push'] }]);
    const t = task((request) =>
      request.command === 'npm test' ? { allow: true } : { allow: false, reason: 'no pushing' },
    );
    await mock.run(t);

    expect(t.asked.map((request) => request.command)).toEqual(['npm test', 'git push']);
    expect(mock.commands).toEqual([
      { command: 'npm test', allowed: true, reason: undefined },
      { command: 'git push', allowed: false, reason: 'no pushing' },
    ]);
    expect(summaries(t)).toEqual([
      'command: ran npm test',
      'output: npm test finished',
      'denied: was not allowed to run git push: no pushing',
    ]);
    expect(t.events[1]).toMatchObject({ output: 'ran: npm test', exitCode: 0, target: 'npm test' });
  });

  it('has no terminal when commands are off or nobody can be asked', async () => {
    const off = task(() => ({ allow: true }), { commands: 'off' });
    const mock = new MockAdapter([{ text: 'done', commands: ['npm test'] }]);
    await mock.run(off);
    expect(off.asked).toEqual([]);
    expect(mock.commands[0]).toMatchObject({ allowed: false });

    await mock.run(task(() => ({ allow: true }), { onCommand: undefined }));
    expect(mock.commands[1]).toMatchObject({ allowed: false });
  });
});

describe('ClaudeCodeAdapter commands', () => {
  // Behaves like \`claude -p\` talked to over stream-json: waits for the hook registration and
  // the prompt, asks about one Bash command through the hook, and runs it only if allowed.
  const FAKE_CLAUDE = `
${LINE_IO}
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
out({ type: 'system', subtype: 'init' });
function onMessage(message) {
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  } else if (message.type === 'user') {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] } });
    out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'hook_callback', callback_id: 'symposium-command', tool_use_id: 'tool-1', input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' } } } });
  } else if (message.type === 'control_response' && message.response.request_id === 'req-1') {
    const decision = message.response.response.hookSpecificOutput;
    if (decision.permissionDecision === 'allow') {
      // The CLI may ask again about the same call. It must get the same answer without a second question to the human.
      out({ type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool-1', input: { command: 'npm test' } } });
    } else {
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: decision.permissionDecisionReason }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'I was not allowed to run the tests.' });
    }
  } else if (message.type === 'control_response' && message.response.request_id === 'req-2') {
    const failing = process.env.FAIL === '1';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: failing, content: failing ? 'Exit code 1\\n1 test failed' : [{ type: 'text', text: '12 tests passed' }] }] } });
    out({ type: 'control_request', request_id: 'req-3', request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'tool-2', input: { file_path: '/etc/hosts' } } });
  } else if (message.type === 'control_response' && message.response.request_id === 'req-3') {
    out({ type: 'control_request', request_id: 'req-4', request: { subtype: 'mystery' } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Tests ran: ' + message.response.response.behavior, total_cost_usd: 0.03 });
  }
}
`;

  function env(extra: Record<string, string> = {}): void {
    process.env.RECEIVED_FILE = join(dir, 'received.json');
    process.env.ARGS_FILE = join(dir, 'args.json');
    process.env.FAIL = extra.FAIL ?? '0';
  }
  const received = () => JSON.parse(readFileSync(join(dir, 'received.json'), 'utf8'));
  afterEach(() => {
    delete process.env.RECEIVED_FILE;
    delete process.env.ARGS_FILE;
    delete process.env.FAIL;
  });

  it('offers Bash only when there is someone to ask, and then asks through the host', () => {
    const toolsOf = (args: string[]) => args[args.indexOf('--tools') + 1];
    const on = claudeCodeArgs(task(() => ({ allow: true })));
    expect(toolsOf(on)).toBe('Read,Grep,Glob,Edit,Write,Bash');
    expect(on.join(' ')).toContain(
      '--input-format stream-json --permission-prompts host --permission-prompt-tool stdio',
    );
    expect(on).toContain('--restricted');

    for (const commands of ['ask', 'allowlist', 'auto'] as const) {
      expect(offersCommands(task(() => ({ allow: true }), { commands }))).toBe(true);
      // No engine to ask: no terminal, whatever the mode says.
      const alone = task(() => ({ allow: true }), { commands, onCommand: undefined });
      expect(toolsOf(claudeCodeArgs(alone))).toBe('Read,Grep,Glob,Edit,Write');
    }
    const off = claudeCodeArgs(task(() => ({ allow: true }), { commands: 'off' }));
    expect(toolsOf(off)).toBe('Read,Grep,Glob,Edit,Write');
    expect(off.join(' ')).toContain('--permission-prompts none');
    expect(off).not.toContain('--input-format');

    const reader = claudeCodeArgs(task(() => ({ allow: true }), { access: 'read' }));
    expect(toolsOf(reader)).toBe('Read,Grep,Glob,Bash');
    expect(reader).not.toContain('acceptEdits');
  });

  it('puts every command to the engine and runs it when allowed', async () => {
    env();
    const t = task(() => ({ allow: true }));
    const reply = await new ClaudeCodeAdapter(fakeNodeCli('claude', FAKE_CLAUDE)).run(t);

    // A file tool reaching outside the folder was refused, without asking the engine.
    expect(reply).toEqual({ text: 'Tests ran: deny', costUsd: 0.03, changedFiles: [] });
    // Asked once, though the CLI asked twice about the same call.
    expect(t.asked).toEqual([{ command: 'npm test', description: 'Run the tests' }]);
    expect(summaries(t)).toEqual(['command: ran npm test', 'output: npm test finished']);
    expect(t.events[1]).toMatchObject({ output: '12 tests passed' });

    const [init, prompt, hookAnswer, toolAnswer, , unknown] = received();
    expect(init.request).toMatchObject({
      subtype: 'initialize',
      hooks: { PreToolUse: [{ matcher: 'Bash', hookCallbackIds: ['symposium-command'] }] },
    });
    expect(prompt).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Please run the tests.' },
    });
    expect(hookAnswer.response.response.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    });
    expect(toolAnswer.response.response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
    });
    expect(unknown.response).toMatchObject({ subtype: 'error', request_id: 'req-4' });
    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toContain('stdio');
  });

  it('does not count the wait for an answer toward the turn’s time', async () => {
    env();
    // The human takes longer to answer than the whole turn may last.
    const slow = async (): Promise<CommandDecision> => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { allow: true };
    };
    const reply = await new ClaudeCodeAdapter(fakeNodeCli('claude', FAKE_CLAUDE)).run(
      task(slow, { timeoutMs: 600 }),
    );
    expect(reply.text).toBe('Tests ran: deny');
  });

  it('reports a failing command with its exit code', async () => {
    env({ FAIL: '1' });
    const t = task(() => ({ allow: true }));
    await new ClaudeCodeAdapter(fakeNodeCli('claude', FAKE_CLAUDE)).run(t);
    expect(summaries(t)).toEqual([
      'command: ran npm test',
      'output: npm test failed (exit code 1)',
    ]);
    expect(t.events[1]).toMatchObject({ output: '1 test failed', exitCode: 1 });
  });

  it('does not run a refused command, and tells the agent why', async () => {
    env();
    const t = task(() => ({ allow: false, reason: 'The CEO said no.' }));
    const reply = await new ClaudeCodeAdapter(fakeNodeCli('claude', FAKE_CLAUDE)).run(t);

    expect(reply.text).toBe('I was not allowed to run the tests.');
    expect(summaries(t)).toEqual(['denied: was not allowed to run npm test: The CEO said no.']);
    expect(received()[2].response.response.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'The CEO said no.',
    });
  });

  it('refuses when the engine fails to decide', async () => {
    env();
    const t = task(() => {
      throw new Error('database is locked');
    });
    await new ClaudeCodeAdapter(fakeNodeCli('claude', FAKE_CLAUDE)).run(t);
    expect(received()[2].response.response.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('AntigravityAdapter commands (agy acp)', () => {
  // Behaves like \`agy acp\`: JSON-RPC over stdio. During the prompt it reads a file, asks
  // permission to run a command, then asks permission to write outside the folder.
  const FAKE_AGY = `
${LINE_IO}
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
const update = (sessionUpdate, fields) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate, ...fields } } });
const say = (text) => update('agent_message_chunk', { content: { type: 'text', text } });
const command = { toolCallId: 'c1', name: 'run_command', kind: 'execute', title: 'npm test', args: { CommandLine: 'npm test' } };
let promptId;
function onMessage(message) {
  const reply = (result) => out({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') reply({ protocolVersion: 1 });
  else if (message.method === 'session/new') reply({ sessionId: 's1' });
  else if (message.method === 'session/set_model' && message.params.modelId === 'no-such-model') out({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown model ID: no-such-model' } });
  else if (message.method === 'session/prompt') {
    promptId = message.id;
    say('Let me look ');
    say('at the project.');
    update('tool_call', { toolCallId: 'r1', name: 'read_file', kind: 'read', status: 'in_progress', args: { Path: process.cwd() + '/package.json' } });
    update('tool_call_update', { toolCallId: 'r1', name: 'read_file', kind: 'read', status: 'completed', args: { Path: process.cwd() + '/package.json' } });
    update('tool_call', { ...command, status: 'in_progress' });
    update('tool_call_update', { ...command, status: 'pending' });
    out({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { ...command, status: 'pending' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
  } else if (message.id === 'perm-1') {
    const allowed = message.result.outcome.optionId === 'allow';
    if (allowed) update('tool_call_update', { ...command, status: 'completed', rawOutput: { output: '12 tests passed', exit_code: 0 } });
    else update('tool_call_update', { ...command, status: 'failed' });
    // The real agy ends the turn here, without a word, when a command is refused.
    if (!allowed && process.env.SILENT === '1') return out({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    const edit = { toolCallId: 'e1', name: 'write_file', kind: 'edit', args: { Path: '/etc/hosts' } };
    out({ jsonrpc: '2.0', id: 'perm-2', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { ...edit, status: 'pending' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
  } else if (message.id === 'perm-2') {
    out({ jsonrpc: '2.0', id: 'other-1', method: 'fs/read_text_file', params: {} });
  } else if (message.id === 'other-1') {
    say('All done: ');
    say(received.find((m) => m.id === 'perm-1').result.outcome.optionId + ', ' + message.error.code);
    out({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  } else reply({});
}
`;

  beforeEach(() => {
    process.env.RECEIVED_FILE = join(dir, 'received.json');
    process.env.ARGS_FILE = join(dir, 'args.json');
  });
  afterEach(() => {
    delete process.env.RECEIVED_FILE;
    delete process.env.ARGS_FILE;
  });
  const received = () => JSON.parse(readFileSync(join(dir, 'received.json'), 'utf8'));
  const calls = () =>
    received()
      .filter((message: { method?: string }) => message.method)
      .map((message: { method: string }) => message.method);

  it('talks ACP when the agent has a terminal, and puts each command to the engine', async () => {
    const t = task(() => ({ allow: true }), { model: 'gemini-3.8-flash-low' });
    const reply = await new AntigravityAdapter(fakeNodeCli('agy', FAKE_AGY)).run(t);

    // The reply is what the agent said after its last tool call. -32601: the file service
    // the agent asked Symposium for does not exist.
    expect(reply).toEqual({
      text: 'All done: allow, -32601',
      warning: undefined,
      changedFiles: [],
    });
    expect(t.asked).toEqual([{ command: 'npm test' }]);
    expect(summaries(t)).toEqual([
      'text: Let me look at the project.',
      'read: read package.json',
      'command: ran npm test',
      'output: npm test finished',
    ]);
    expect(t.events[3]).toMatchObject({ output: '12 tests passed', exitCode: 0 });

    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual(['acp', '--sandbox']);
    expect(calls()).toEqual([
      'initialize',
      'session/new',
      'session/set_mode',
      'session/set_model',
      'session/prompt',
    ]);
    const sent = received();
    expect(sent[1].params).toEqual({ cwd: dir, mcpServers: [] });
    expect(sent[2].params.modeId).toBe('accept-edits');
    expect(sent[3].params.modelId).toBe('gemini-3.8-flash-low');
    expect(sent[4].params.prompt[0].text).toContain('You are Ada.');
    expect(sent[4].params.prompt[0].text).toContain('Please run the tests.');
    // The edit outside the folder was refused without asking anyone.
    expect(sent.find((message: { id?: unknown }) => message.id === 'perm-2').result).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
  });

  it.skipIf(!canSandbox)(
    "leaves out agy's own sandbox when Symposium's sandbox confines the process",
    async () => {
      const t = task(() => ({ allow: true }), {
        sandbox: { writable: [dir], readOnly: [], hidden: [] },
      });
      const reply = await new AntigravityAdapter(fakeNodeCli('agy', FAKE_AGY)).run(t);
      expect(reply.text).toBe('All done: allow, -32601');
      expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual(['acp']);
    },
  );

  it('refuses a command the engine refuses', async () => {
    const t = task(() => ({ allow: false, reason: 'not on the list' }));
    const reply = await new AntigravityAdapter(fakeNodeCli('agy', FAKE_AGY)).run(t);
    expect(reply.text).toBe('All done: deny, -32601');
    expect(summaries(t).slice(2)).toEqual([
      'denied: was not allowed to run npm test: not on the list',
    ]);
  });

  it('says so when agy ends its turn silently after a refusal', async () => {
    process.env.SILENT = '1';
    try {
      const t = task(() => ({ allow: false, reason: 'The CEO said no.' }));
      const reply = await new AntigravityAdapter(fakeNodeCli('agy', FAKE_AGY)).run(t);
      // What the agent said before the command is all it said, so that is the reply.
      expect(reply.text).toBe('Let me look at the project.');

      const quiet = FAKE_AGY.replace("say('Let me look ');", '').replace(
        "say('at the project.');",
        '',
      );
      const silent = await new AntigravityAdapter(fakeNodeCli('agy', quiet)).run(
        task(() => ({ allow: false, reason: 'The CEO said no.' })),
      );
      expect(silent.text).toBe(
        '(Stopped without a reply: `npm test` was not allowed to run, and Antigravity ends its turn when a command is refused.)',
      );
    } finally {
      delete process.env.SILENT;
    }
  });

  it('asks about edits too when the agent may only read, and sets the effort', async () => {
    const t = task(() => ({ allow: true }), {
      access: 'read',
      model: 'gemini-3.8-flash-low',
      effort: 'high',
    });
    await new AntigravityAdapter(fakeNodeCli('agy', FAKE_AGY)).run(t);
    const sent = received();
    expect(sent[2].params.modeId).toBe('default');
    expect(sent[3]).toMatchObject({
      method: 'session/set_config_option',
      params: { configId: 'model', value: 'gemini-3.8-flash' },
    });
    expect(sent[4].params).toMatchObject({ configId: 'thought_level', value: 'high' });
  });

  it('explains a model agy does not know', async () => {
    const t = task(() => ({ allow: true }), { model: 'no-such-model' });
    await expect(new AntigravityAdapter(fakeNodeCli('agy', FAKE_AGY)).run(t)).rejects.toThrow(
      /does not accept this model/,
    );
  });

  it('reports an agy that exits before the turn is over', async () => {
    const t = task(() => ({ allow: true }));
    const cli = fakeNodeCli('agy', 'process.stderr.write("not logged in\\n"); process.exit(3);');
    const failure = await new AntigravityAdapter(cli).run(t).catch((error: unknown) => error);
    expect(String(failure)).toMatch(/agy acp exited with code 3/);
  });

  it('keeps to print mode for agents without a terminal', async () => {
    const cli = fakeNodeCli(
      'agy',
      `require('node:fs').writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
       console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Printed.' } }));`,
    );
    const t = task(() => ({ allow: true }), { commands: 'off' });
    expect((await new AntigravityAdapter(cli).run(t)).text).toBe('Printed.');
    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))[0]).toBe('-p');
  });
});
