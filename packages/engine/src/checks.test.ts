import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAdapter, type MockReply } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeCheck, MAX_CHECK_OUTPUT, runCheck } from './checks.js';
import type { Agent, Group, Message } from './protocol.js';
import { listEvents } from './store/events.js';
import { createTestApp, waitFor, type TestApp } from './testing.js';

describe('runCheck', () => {
  it('passes when the command exits with 0, and keeps what it printed', async () => {
    const check = await runCheck('echo all good', tmpdir());
    expect(check).toMatchObject({
      command: 'echo all good',
      status: 'passed',
      exitCode: 0,
      output: 'all good\n',
    });
  });

  it('fails with the exit code and the error output', async () => {
    const check = await runCheck('echo broken >&2; exit 3', tmpdir());
    expect(check).toMatchObject({ status: 'failed', exitCode: 3, output: 'broken\n' });
    expect(describeCheck(check)).toBe('failed (exit code 3)');
  });

  it('keeps only the end of a long output', async () => {
    const check = await runCheck(
      `head -c ${MAX_CHECK_OUTPUT * 2} /dev/zero | tr '\\0' x; echo END`,
      tmpdir(),
    );
    expect(check.status).toBe('passed');
    expect(check.output.startsWith('… earlier output left out\n')).toBe(true);
    expect(check.output.endsWith('END\n')).toBe(true);
    expect(check.output.length).toBeLessThan(MAX_CHECK_OUTPUT + 100);
  });

  it('stops a command that runs too long, with whatever it started', async () => {
    const check = await runCheck('sleep 30 & sleep 30', tmpdir(), { timeoutMs: 100 });
    expect(check).toMatchObject({ status: 'timed-out', exitCode: null });
    expect(check.durationMs).toBeLessThan(5000);
  });

  it('stops when asked to, and does not start once stopped', async () => {
    const controller = new AbortController();
    const running = runCheck('sleep 30', tmpdir(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await running).status).toBe('stopped');
    expect((await runCheck('echo hi', tmpdir(), { signal: controller.signal })).status).toBe(
      'stopped',
    );
  });

  it('reports a folder that is not there instead of throwing', async () => {
    const check = await runCheck('echo hi', join(tmpdir(), 'symposium-no-such-folder'));
    expect(check.status).toBe('error');
    expect(check.output).toContain('Could not start');
  });
});

describe('checks on a worker’s change', () => {
  let t: TestApp;
  let group: Group;
  let folder: string;

  beforeEach(async () => {
    t = await createTestApp();
    folder = join(t.workDir, 'shop');
    group = (
      await t.request({
        method: 'POST',
        url: '/api/groups',
        payload: { name: 'Shop', folderPath: folder },
      })
    ).json();
  });
  afterEach(async () => {
    await t.close();
  });

  function setGroup(changes: Record<string, unknown>) {
    return t.request({ method: 'PATCH', url: `/api/groups/${group.id}`, payload: changes });
  }

  async function hire(name: string, role: Agent['role'], script: MockReply[]): Promise<Agent> {
    t.mocks.set(name, new MockAdapter(script));
    return (
      await t.request({
        method: 'POST',
        url: `/api/groups/${group.id}/agents`,
        payload: { name, role, provider: 'mock', model: 'mock' },
      })
    ).json();
  }

  function post(body: string) {
    return t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages`,
      payload: { body },
    });
  }

  async function say(body: string): Promise<void> {
    await post(body);
    await t.app.symposium.runner.waitForIdle(group.id);
  }

  async function diffMessages(): Promise<Message[]> {
    const all: Message[] = (
      await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })
    ).json();
    return all.filter((m) => m.meta?.type === 'diff');
  }

  it('starts with no check, and takes one from the human', async () => {
    expect(group.checkCommand).toBe('');
    const res = await setGroup({ checkCommand: '  npm test  ' });
    expect(res.json().checkCommand).toBe('npm test');
    expect((await setGroup({ checkCommand: 'x'.repeat(2000) })).statusCode).toBe(400);
  });

  it('runs nothing when no check is set', async () => {
    await hire('Ada', 'worker', [{ text: 'Cart.', files: { 'cart.ts': 'v1\n' } }]);
    await say('@Ada cart');
    const [diff] = await diffMessages();
    expect(diff!.meta).not.toHaveProperty('check');
  });

  it("runs the check in the worker's worktree and puts the result on the diff", async () => {
    // Passes only where Ada's new file is: in her worktree, not in the project folder.
    await setGroup({ checkCommand: 'test -f cart.ts && echo found the cart' });
    await hire('Ada', 'worker', [{ text: 'Cart.', files: { 'cart.ts': 'v1\n' } }]);
    await say('@Ada cart');

    expect(existsSync(join(folder, 'cart.ts'))).toBe(false);
    const [diff] = await diffMessages();
    expect(diff!.meta).toMatchObject({
      status: 'pending',
      check: {
        command: 'test -f cart.ts && echo found the cart',
        status: 'passed',
        exitCode: 0,
        output: 'found the cart\n',
      },
    });
    const event = listEvents(t.db, group.id).find((e) => e.kind === 'check.run');
    expect(event!.detail).toMatchObject({ status: 'passed', exitCode: 0 });
  });

  it('shows a failed check to the lead before the lead decides what is next', async () => {
    await setGroup({ leadAsksFirst: false, checkCommand: 'echo "1 test failed"; exit 1' });
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Needs a fix.' }]);
    await hire('Ada', 'worker', [{ text: 'Cart.', files: { 'cart.ts': 'v1\n' } }]);
    await say('Build a shop');

    const [diff] = await diffMessages();
    expect(diff!.meta).toMatchObject({ check: { status: 'failed', exitCode: 1 } });
    // Ada's report reached Lea only after the check, so Lea reads the result with it.
    const prompt = t.mocks.get('Lea')!.calls[1]!.prompt;
    expect(prompt).toContain('Check `echo "1 test failed"; exit 1`: failed (exit code 1)');
    expect(prompt).toContain('1 test failed');
    // Both are told that the engine runs the check, so neither asks for it to be run again.
    expect(t.mocks.get('Lea')!.calls[1]!.systemPrompt).toContain("runs the project's check");
    expect(t.mocks.get('Ada')!.calls[0]!.systemPrompt).toContain('You need not run it yourself');
  });

  it('can still be merged by the human when the check failed', async () => {
    await setGroup({ checkCommand: 'exit 1' });
    await hire('Ada', 'worker', [{ text: 'Cart.', files: { 'cart.ts': 'v1\n' } }]);
    await say('@Ada cart');
    const [diff] = await diffMessages();
    const merged = await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${diff!.id}/merge`,
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().meta).toMatchObject({ status: 'merged', check: { status: 'failed' } });
  });

  it('stops the check when the human stops the agent', async () => {
    await setGroup({ checkCommand: 'sleep 30' });
    const ada = await hire('Ada', 'worker', [{ text: 'Cart.', files: { 'cart.ts': 'v1\n' } }]);
    await post('@Ada cart');
    let running: Message | undefined;
    await waitFor(() => {
      void diffMessages().then((diffs) => (running = diffs[0]));
      return running?.meta?.type === 'diff' && running.meta.check?.status === 'running';
    });

    await t.request({ method: 'POST', url: `/api/groups/${group.id}/agents/${ada.id}/stop` });
    await t.app.symposium.runner.waitForIdle(group.id);
    const [diff] = await diffMessages();
    expect(diff!.meta).toMatchObject({ status: 'pending', check: { status: 'stopped' } });
  });
});
