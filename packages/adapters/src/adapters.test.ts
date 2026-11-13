import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AntigravityAdapter,
  antigravityArgs,
  antigravityEventReader,
  parseAntigravityOutput,
} from './antigravity.js';
import {
  ClaudeCodeAdapter,
  claudeCodeArgs,
  claudeEventReader,
  parseClaudeOutput,
} from './claude-code.js';
import { displayPath, toolEvent } from './events.js';
import { changedBetween, parsePorcelainZ, reportingFileChanges } from './file-changes.js';
import { MockAdapter } from './mock.js';
import { listModels, parseAgyModels } from './models.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { cleanTerminalOutput, commandExists, runProcess } from './process.js';
import { createAdapter, PROVIDERS } from './registry.js';
import { AdapterError, CancelledError, type AgentEvent, type AgentTask } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symposium-adapters-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    agentName: 'Ada',
    model: 'test-model',
    systemPrompt: 'You are Ada.',
    prompt: 'Please say hello.',
    trigger: 'Please say hello.',
    workingDirectory: dir,
    access: 'read',
    ...overrides,
  };
}

/** Writes an executable shell script and returns its path. */
function fakeCli(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A fake CLI that prints the given objects as JSON lines, the way a streaming CLI does. */
function streamingCli(name: string, lines: unknown[]): string {
  const file = join(dir, `${name}-stream.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return fakeCli(name, `cat > /dev/null; cat '${file}'`);
}

/** A listener for `task.onEvent` that keeps the events it is given. */
function collectEvents(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

describe('runProcess', () => {
  it('collects output and the exit code', async () => {
    const result = await runProcess({
      command: 'sh',
      args: ['-c', 'cat; echo err >&2; exit 3'],
      cwd: dir,
      input: 'hi',
    });
    expect(result).toEqual({ stdout: 'hi', stderr: 'err\n', exitCode: 3 });
  });

  it('reports a missing command clearly', async () => {
    await expect(
      runProcess({ command: 'definitely-not-a-command-xyz', args: [], cwd: dir }),
    ).rejects.toThrow(/Command not found/);
  });

  it('stops the process when cancelled', async () => {
    const controller = new AbortController();
    const running = runProcess({
      command: 'sleep',
      args: ['10'],
      cwd: dir,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toBeInstanceOf(CancelledError);
  });

  it('times out', async () => {
    await expect(
      runProcess({ command: 'sleep', args: ['10'], cwd: dir, timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });

  it('hands over each line of output as it arrives, even when a line comes in pieces', async () => {
    const lines: string[] = [];
    const arrivals: number[] = [];
    const result = await runProcess({
      command: 'sh',
      args: ['-c', `printf 'one\\ntw'; sleep 0.2; printf 'o\\r\\nthr'; sleep 0.1; printf 'ee'`],
      cwd: dir,
      onStdoutLine: (line) => {
        lines.push(line);
        arrivals.push(Date.now());
      },
    });
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(result.stdout).toBe('one\ntwo\r\nthree');
    // The first line was handed over while the process was still running.
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThan(100);
  });

  it('finds commands on PATH', async () => {
    expect(await commandExists('sh')).toBe(true);
    expect(await commandExists('definitely-not-a-command-xyz')).toBe(false);
  });

  it('strips terminal escape codes', () => {
    expect(cleanTerminalOutput('\x1b[32mgreen\x1b[0m\r\nnext')).toBe('green\nnext');
  });
});

describe('MockAdapter', () => {
  it('replies from a script in order and repeats the last reply', async () => {
    const mock = new MockAdapter([{ text: 'one' }, { text: 'two' }]);
    expect((await mock.run(task())).text).toBe('one');
    expect((await mock.run(task())).text).toBe('two');
    expect((await mock.run(task())).text).toBe('two');
    expect(mock.calls).toHaveLength(3);
  });

  it('echoes the trigger by default', async () => {
    const reply = await new MockAdapter([{ text: 'x' }]).run(task());
    expect(reply.text).toBe('x');
    const echo = await new MockAdapter().run(task({ trigger: 'Build the login page' }));
    expect(echo.text).toContain('Build the login page');
  });

  it('writes files when it has edit access', async () => {
    const mock = new MockAdapter([{ text: 'done', files: { 'src/a.txt': 'hello' } }]);
    const reply = await mock.run(task({ access: 'edit' }));
    expect(reply.changedFiles).toEqual(['src/a.txt']);
    expect(readFileSync(join(dir, 'src/a.txt'), 'utf8')).toBe('hello');
  });

  it('refuses to write files without edit access or outside the folder', async () => {
    await expect(
      new MockAdapter([{ text: 'x', files: { 'a.txt': 'x' } }]).run(task({ access: 'read' })),
    ).rejects.toThrow(/without edit access/);
    await expect(
      new MockAdapter([{ text: 'x', files: { '../escape.txt': 'x' } }]).run(
        task({ access: 'edit' }),
      ),
    ).rejects.toThrow(/outside the working directory/);
  });

  it('reports scripted progress events', async () => {
    const { events, onEvent } = collectEvents();
    const scripted = [toolEvent('read', 'Read', 'src/cart.ts'), toolEvent('edit', 'Edit', 'a.ts')];
    const mock = new MockAdapter([{ text: 'done', events: scripted }]);
    await mock.run(task({ onEvent }));
    expect(events.map((event) => event.summary)).toEqual(['read src/cart.ts', 'edited a.ts']);
    // A task without a listener still works.
    expect((await mock.run(task())).text).toBe('done');
  });

  it('fails a turn on request and can be cancelled', async () => {
    await expect(new MockAdapter([{ text: '', error: 'boom' }]).run(task())).rejects.toThrow(
      'boom',
    );
    const controller = new AbortController();
    const running = new MockAdapter([{ text: 'slow', delayMs: 5000 }]).run(
      task({ signal: controller.signal }),
    );
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('ClaudeCodeAdapter', () => {
  it('never offers Bash and only allows edits with edit access', () => {
    const readArgs = claudeCodeArgs(task({ access: 'read' }));
    const editArgs = claudeCodeArgs(task({ access: 'edit' }));
    const noneArgs = claudeCodeArgs(task({ access: 'none' }));
    const toolsOf = (args: string[]) => args[args.indexOf('--tools') + 1];

    expect(toolsOf(readArgs)).toBe('Read,Grep,Glob');
    expect(toolsOf(editArgs)).toBe('Read,Grep,Glob,Edit,Write');
    expect(toolsOf(noneArgs)).toBe('');
    for (const args of [readArgs, editArgs, noneArgs]) {
      expect(args.join(' ')).not.toMatch(/Bash/);
      expect(args).toContain('--restricted');
    }
    expect(readArgs).not.toContain('acceptEdits');
    expect(editArgs).toContain('acceptEdits');
  });

  it('passes the model and effort through, and leaves a default effort to the CLI', () => {
    const args = claudeCodeArgs(task({ model: 'claude-opus-5-5', effort: 'high' }));
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'claude-opus-5-5',
    ]);
    expect(args.slice(args.indexOf('--effort'))).toEqual(['--effort', 'high']);
    expect(claudeCodeArgs(task({ effort: 'default' }))).not.toContain('--effort');
    expect(claudeCodeArgs(task())).not.toContain('--effort');
  });

  it('offers no command tools in any command mode until approvals exist', () => {
    for (const commands of ['off', 'ask', 'allowlist', 'auto'] as const) {
      const args = claudeCodeArgs(task({ access: 'edit', commands }));
      expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob,Edit,Write');
      expect(args).toContain('--restricted');
    }
  });

  it('sends the prompt on stdin and parses the JSON result', async () => {
    const argsFile = join(dir, 'args.txt');
    const stdinFile = join(dir, 'stdin.txt');
    const cli = fakeCli(
      'claude',
      `printf '%s\\n' "$@" > '${argsFile}'
cat > '${stdinFile}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Hello from Claude","total_cost_usd":0.02}'`,
    );
    const reply = await new ClaudeCodeAdapter(cli).run(task({ model: 'haiku' }));

    expect(reply).toEqual({ text: 'Hello from Claude', costUsd: 0.02, changedFiles: [] });
    expect(readFileSync(stdinFile, 'utf8')).toBe('Please say hello.');
    const args = readFileSync(argsFile, 'utf8').split('\n');
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'haiku', 'You are Ada.']));
  });

  it('asks for a stream and reports what the agent does as it goes', async () => {
    const args = claudeCodeArgs(task());
    expect(
      args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 3),
    ).toEqual(['--output-format', 'stream-json', '--verbose']);

    const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });
    const toolResult = (id: string, isError = false) => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
    });
    const use = (id: string, name: string, input: unknown) => ({
      type: 'tool_use',
      id,
      name,
      input,
    });
    const cli = streamingCli('claude', [
      { type: 'system', subtype: 'init', cwd: dir },
      assistant({ type: 'thinking', thinking: 'hmm' }),
      assistant({ type: 'text', text: 'Let me look at\nthe cart.' }),
      assistant(use('t1', 'Read', { file_path: join(dir, 'src/cart.ts') })),
      toolResult('t1'),
      { type: 'rate_limit_event' },
      assistant(use('t2', 'Glob', { pattern: '**/*.ts', path: dir })),
      toolResult('t2'),
      assistant(use('t3', 'Edit', { file_path: join(dir, 'src/cart.ts') })),
      toolResult('t3'),
      assistant(use('t4', 'Write', { file_path: '/etc/passwd' })),
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Write',
        decision_reason: 'outside the working directory',
      },
      toolResult('t4', true),
      assistant(use('t5', 'WebFetch', { url: 'https://example.com' })),
      toolResult('t5'),
      assistant({ type: 'text', text: 'All done.' }),
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'All done.',
        total_cost_usd: 0.01,
      },
    ]);
    const { events, onEvent } = collectEvents();
    const reply = await new ClaudeCodeAdapter(cli).run(task({ access: 'edit', onEvent }));

    expect(reply).toEqual({ text: 'All done.', costUsd: 0.01, changedFiles: [] });
    expect(events.map((event) => `${event.kind}: ${event.summary}`)).toEqual([
      'text: Let me look at the cart.',
      'read: read src/cart.ts',
      'search: searched for **/*.ts',
      'edit: edited src/cart.ts',
      'denied: was refused Write: outside the working directory',
      'tool: used WebFetch on https://example.com',
    ]);
    expect(events[1]).toEqual({
      kind: 'read',
      tool: 'Read',
      target: 'src/cart.ts',
      summary: 'read src/cart.ts',
    });
  });

  it('reports an edit only once it has happened', () => {
    const { events, onEvent } = collectEvents();
    const read = claudeEventReader('/work', onEvent);
    const edit = { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/work/a.ts' } };
    read(JSON.stringify({ type: 'assistant', message: { content: [edit] } }));
    expect(events).toEqual([]);
    read('not json at all');
    read(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'e1' }] },
      }),
    );
    expect(events.map((event) => event.summary)).toEqual(['edited a.ts']);
  });

  it('shows paths relative to the working folder, and others in full', () => {
    expect(displayPath('/work/src/a.ts', '/work')).toBe('src/a.ts');
    expect(displayPath('/work', '/work')).toBe('.');
    expect(displayPath('/elsewhere/a.ts', '/work')).toBe('/elsewhere/a.ts');
    expect(displayPath('src/a.ts', '/work')).toBe('src/a.ts');
    expect(toolEvent('search', 'grep_search').summary).toBe('searched the files');
    expect(toolEvent('tool', 'WebSearch').summary).toBe('used WebSearch');

    // A very long target is cut in the middle for the summary and kept whole as the target.
    const long = `/tmp/${'deep/'.repeat(30)}placeholder.txt`;
    const event = toolEvent('edit', 'Write', long);
    expect(event.target).toBe(long);
    expect(event.summary).toMatch(/^edited \/tmp\/deep\/.*….*\/placeholder\.txt$/);
    expect(event.summary.length).toBeLessThan(90);
  });

  it('finds the result in a stream, and says so when there is none', () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Hi","total_cost_usd":0.5}',
      '',
    ].join('\n');
    expect(parseClaudeOutput(stream)).toEqual({ text: 'Hi', costUsd: 0.5 });
    expect(() =>
      parseClaudeOutput('{"type":"system","subtype":"init"}\n{"type":"user"}\n'),
    ).toThrow(/stopped before giving a result/);
    expect(() =>
      parseClaudeOutput(
        '{"type":"system"}\n{"type":"result","subtype":"error_during_execution","is_error":true}',
      ),
    ).toThrow(/error_during_execution/);
  });

  it('reports errors from Claude Code', () => {
    expect(() =>
      parseClaudeOutput('{"is_error":true,"subtype":"error_max_turns","result":"x"}'),
    ).toThrow(/error_max_turns/);
    expect(() => parseClaudeOutput('not json')).toThrow(/not JSON/);
  });

  it('reports a failing CLI', async () => {
    const cli = fakeCli('claude', 'echo "not logged in" >&2; exit 1');
    await expect(new ClaudeCodeAdapter(cli).run(task())).rejects.toBeInstanceOf(AdapterError);
  });
});

describe('AntigravityAdapter', () => {
  it('parses JSON output', async () => {
    const cli = fakeCli('agy', `echo '{"status":"SUCCESS","response":"Hi from agy\\n"}'`);
    const reply = await new AntigravityAdapter(cli).run(task());
    expect(reply.text).toBe('Hi from agy');
  });

  it('puts the system prompt in the prompt and maps access to modes', async () => {
    const argsFile = join(dir, 'args.txt');
    const cli = fakeCli(
      'agy',
      `printf '%s\\n' "$@" > '${argsFile}'; echo '{"status":"SUCCESS","response":"ok"}'`,
    );
    await new AntigravityAdapter(cli).run(task({ access: 'edit' }));
    const args = readFileSync(argsFile, 'utf8');
    expect(args).toContain('You are Ada.');
    expect(args).toContain('Please say hello.');
    expect(args).toContain('accept-edits');
    expect(args).toContain('--sandbox');
  });

  it('passes the model and effort through, and keeps the sandbox in every command mode', () => {
    const args = antigravityArgs(task({ model: 'gpt-oss-120b', effort: 'max' }));
    expect(args.slice(-4)).toEqual(['--model', 'gpt-oss-120b', '--effort', 'max']);
    expect(antigravityArgs(task({ effort: 'default' }))).not.toContain('--effort');
    expect(antigravityArgs(task({ access: 'edit', commands: 'auto' }))).toContain('--sandbox');
  });

  it('lets the effort setting replace an effort in the model name, which agy would refuse', () => {
    const args = antigravityArgs(task({ model: 'gemini-3.8-flash-medium', effort: 'low' }));
    expect(args.slice(-4)).toEqual(['--model', 'gemini-3.8-flash', '--effort', 'low']);
    // Without an effort setting the name is passed as it is.
    expect(antigravityArgs(task({ model: 'gemini-3.8-flash-medium' })).slice(-2)).toEqual([
      '--model',
      'gemini-3.8-flash-medium',
    ]);
    expect(
      antigravityArgs(task({ model: 'claude-opus-4-6-thinking', effort: 'high' })).slice(-4),
    ).toEqual(['--model', 'claude-opus-4-6-thinking', '--effort', 'high']);
  });

  it('explains a model that does not take an effort', async () => {
    const cli = fakeCli(
      'agy',
      `echo 'error: invalid model selection (--model "x" --effort "low"): --effort is not supported for model "x"' >&2; exit 1`,
    );
    const failure = await new AntigravityAdapter(cli)
      .run(task({ model: 'x', effort: 'low' }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).message).toMatch(/Set the effort to Default/);
    expect((failure as AdapterError).details).toContain('not supported for model');
  });

  it('asks for a stream and reports tool steps once each, edits when they are done', async () => {
    expect(antigravityArgs(task())).toContain('stream-json');
    const step = (index: number, state: string, tool: string, parameters: unknown = {}) => ({
      event: 'step_update',
      step_update: {
        step_index: index,
        state,
        step_type: 'tool',
        tool_name: tool,
        tool_info: { name: tool, parameters },
      },
    });
    const file = join(dir, 'src/cart.ts');
    const cli = streamingCli('agy', [
      { event: 'init', init: { model: 'x' } },
      step(1, 'ACTIVE', 'view_file', { Path: file }),
      step(1, 'DONE', 'view_file', { Path: file }),
      step(2, 'ACTIVE', 'grep_search', { Path: dir }),
      step(2, 'DONE', 'grep_search', { Path: dir }),
      step(3, 'ACTIVE', 'edit_file', { Path: file }),
      step(3, 'DONE', 'edit_file', { Path: file }),
      step(4, 'ACTIVE', 'browser_preview', { Url: 'http://localhost' }),
      {
        event: 'step_update',
        step_update: {
          step_index: 5,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'Do',
        },
      },
      { event: 'result', result: { status: 'SUCCESS', response: 'Done.\n' } },
    ]);
    const { events, onEvent } = collectEvents();
    const reply = await new AntigravityAdapter(cli).run(task({ access: 'edit', onEvent }));

    expect(reply.text).toBe('Done.');
    expect(events.map((event) => `${event.kind}: ${event.summary}`)).toEqual([
      'read: read src/cart.ts',
      'search: searched the files',
      'edit: edited src/cart.ts',
      'tool: used browser_preview',
    ]);

    // An edit that is still going on is not reported yet.
    const early = collectEvents();
    antigravityEventReader(
      dir,
      early.onEvent,
    )(JSON.stringify(step(1, 'ACTIVE', 'write_file', { Path: file })));
    expect(early.events).toEqual([]);
  });

  it('finds the result in a stream, and says so when there is none', () => {
    const init = '{"event":"init","init":{}}';
    expect(
      parseAntigravityOutput(
        `${init}\n{"event":"result","result":{"status":"SUCCESS","response":"Hi {there}"}}\n`,
      ),
    ).toEqual({ text: 'Hi {there}' });
    expect(
      parseAntigravityOutput(
        `${init}\n{"event":"result","result":{"status":"ERROR","response":"Did it."}}`,
      ),
    ).toEqual({ text: 'Did it.', warning: 'Antigravity reported status ERROR' });
    expect(() => parseAntigravityOutput(`${init}\n`)).toThrow(/stopped before giving a result/);
  });

  const hasPty = existsSync('/usr/bin/python3') || existsSync('/usr/bin/script');
  it.runIf(hasPty)('falls back to a pseudo-terminal when it prints nothing to a pipe', async () => {
    // Prints only when stdout is a terminal, like `agy -p` can.
    const cli = fakeCli(
      'agy',
      `if [ -t 1 ]; then echo '{"status":"SUCCESS","response":"from a terminal"}'; fi`,
    );
    const reply = await new AntigravityAdapter(cli).run(task());
    expect(reply.text).toBe('from a terminal');
  });

  it.runIf(hasPty)('still reports tool steps after falling back to a pseudo-terminal', async () => {
    const lines = [
      '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"tool","tool_name":"list_dir","tool_info":{"parameters":{"Path":"/elsewhere"}}}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"Listed."}}',
    ];
    const file = join(dir, 'pty-stream.jsonl');
    writeFileSync(file, lines.join('\n') + '\n');
    const cli = fakeCli('agy', `if [ -t 1 ]; then cat '${file}'; fi`);
    const { events, onEvent } = collectEvents();
    const reply = await new AntigravityAdapter(cli).run(task({ onEvent }));
    expect(reply.text).toBe('Listed.');
    expect(events.map((event) => event.summary)).toEqual(['read /elsewhere']);
  });

  it('keeps a real reply that arrives with an error status, as a warning', () => {
    expect(parseAntigravityOutput('{"status":"ERROR","response":"Done."}')).toEqual({
      text: 'Done.',
      warning: 'Antigravity reported status ERROR',
    });
    expect(() => parseAntigravityOutput('{"status":"ERROR","response":""}')).toThrow(/ERROR/);
    expect(parseAntigravityOutput('plain text answer\n')).toEqual({ text: 'plain text answer' });
  });
});

describe('OpenAICompatibleAdapter', () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { headers: IncomingMessage['headers']; body: unknown } | undefined;
  let respond: (res: import('node:http').ServerResponse) => void;

  beforeEach(async () => {
    lastRequest = undefined;
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: ' Hi from the API ' } }] }));
    };
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        lastRequest = { headers: req.headers, body: JSON.parse(raw) };
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('sends a chat completion and returns the content', async () => {
    const adapter = new OpenAICompatibleAdapter({
      baseUrl,
      apiKeyEnv: 'TEST_KEY',
      env: { TEST_KEY: 'sk-test' },
    });
    const reply = await adapter.run(task());
    expect(reply.text).toBe('Hi from the API');
    expect(lastRequest?.headers.authorization).toBe('Bearer sk-test');
    expect(lastRequest?.body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'You are Ada.' },
        { role: 'user', content: 'Please say hello.' },
      ],
    });
  });

  it('works without a key, as Ollama does', async () => {
    await new OpenAICompatibleAdapter({ baseUrl }).run(task());
    expect(lastRequest?.headers.authorization).toBeUndefined();
  });

  it('fails clearly when the key variable is missing', async () => {
    const adapter = new OpenAICompatibleAdapter({ baseUrl, apiKeyEnv: 'MISSING', env: {} });
    await expect(adapter.run(task())).rejects.toThrow(/MISSING is not set/);
  });

  it('reports API errors', async () => {
    respond = (res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    };
    await expect(new OpenAICompatibleAdapter({ baseUrl }).run(task())).rejects.toThrow(
      /401: bad key/,
    );
  });
});

describe('listModels', () => {
  it('reads the model list from agy', async () => {
    const output = [
      'Fetching available models...',
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
      'bare-model',
      '',
    ].join('\n');
    expect(parseAgyModels(output)).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
      { id: 'bare-model' },
    ]);

    const argsFile = join(dir, 'args.txt');
    const cli = fakeCli('agy', `echo "$@" > '${argsFile}'; printf 'm-one\\tModel One\\n'`);
    expect(await listModels('antigravity', { command: cli })).toEqual([
      { id: 'm-one', label: 'Model One' },
    ]);
    expect(readFileSync(argsFile, 'utf8').trim()).toBe('models');
  });

  it('reports an agy that cannot list models', async () => {
    const cli = fakeCli('agy', 'echo "not logged in" >&2; exit 1');
    await expect(listModels('antigravity', { command: cli })).rejects.toThrow(/exited with code 1/);
    await expect(listModels('antigravity', { command: join(dir, 'missing') })).rejects.toThrow(
      /Command not found/,
    );
  });

  it('asks an OpenAI-compatible API for its models, with the key from the environment', async () => {
    let authorization: string | undefined;
    const server = createServer((req, res) => {
      authorization = req.headers.authorization;
      if (req.url !== '/v1/models') {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder' }, { id: 'llama3.2' }, {}] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      const baseUrl = `http://127.0.0.1:${port}/v1/`;
      const env = { TEST_KEY: 'sk-test' };
      expect(
        await listModels('openai-compatible', { baseUrl, apiKeyEnv: 'TEST_KEY' }, { env }),
      ).toEqual([{ id: 'llama3.2' }, { id: 'qwen2.5-coder' }]);
      expect(authorization).toBe('Bearer sk-test');

      await expect(
        listModels('openai-compatible', { baseUrl, apiKeyEnv: 'MISSING_KEY' }, { env }),
      ).rejects.toThrow(/MISSING_KEY is not set/);
      await expect(
        listModels('openai-compatible', { baseUrl: `http://127.0.0.1:${port}/nope` }),
      ).rejects.toThrow(/answered 404/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('answers with aliases for Claude Code, which has no listing command', async () => {
    expect((await listModels('claude-code')).map((model) => model.id)).toEqual([
      'sonnet',
      'opus',
      'haiku',
      'fable',
    ]);
    expect(await listModels('mock')).toEqual([{ id: 'mock' }]);
  });
});

describe('file change reporting', () => {
  it('parses porcelain output, including renames', () => {
    const entries = parsePorcelainZ(' M a.ts\0?? new.ts\0R  b.ts\0old-b.ts\0');
    expect([...entries]).toEqual([
      ['a.ts', ' M'],
      ['new.ts', '??'],
      ['b.ts', 'R '],
    ]);
  });

  it('lists paths whose status changed', () => {
    const before = new Map([
      ['a', ' M'],
      ['gone', '??'],
    ]);
    const after = new Map([
      ['a', ' M'],
      ['b', '??'],
    ]);
    expect(changedBetween(before, after)).toEqual(['b', 'gone']);
  });

  it('reports files an agent changed in a git work tree', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, 'existing.txt'), 'untouched');
    const adapter = reportingFileChanges(
      new MockAdapter([{ text: 'x', files: { 'made.txt': 'new' } }]),
    );
    const reply = await adapter.run(task({ access: 'edit' }));
    expect(reply.changedFiles).toEqual(['made.txt']);
  });
});

describe('registry', () => {
  it('creates an adapter for every listed provider', () => {
    for (const provider of PROVIDERS) {
      expect(createAdapter(provider.id).provider).toBe(provider.id);
    }
  });
});
