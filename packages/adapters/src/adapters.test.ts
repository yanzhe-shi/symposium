import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityAdapter, parseAntigravityOutput } from './antigravity.js';
import { ClaudeCodeAdapter, claudeCodeArgs, parseClaudeOutput } from './claude-code.js';
import { changedBetween, parsePorcelainZ, reportingFileChanges } from './file-changes.js';
import { MockAdapter } from './mock.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { cleanTerminalOutput, commandExists, runProcess } from './process.js';
import { createAdapter, PROVIDERS } from './registry.js';
import { AdapterError, CancelledError, type AgentTask } from './types.js';

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
