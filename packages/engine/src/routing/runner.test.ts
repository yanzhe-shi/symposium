import { join } from 'node:path';
import { MockAdapter, type MockReply } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMemory } from '../memory.js';
import type { Agent, Group, HireRequest, Message } from '../protocol.js';
import { listEvents } from '../store/events.js';
import { createTestApp, waitFor, type TestApp } from '../testing.js';

let t: TestApp;
let group: Group;

beforeEach(async () => {
  t = await createTestApp();
  group = (
    await t.request({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Shop', folderPath: join(t.workDir, 'shop') },
    })
  ).json();
});
afterEach(async () => {
  await t.close();
});

async function hire(name: string, role: HireRequest['role'], script?: MockReply[]): Promise<Agent> {
  if (script) t.mocks.set(name, new MockAdapter(script));
  const res = await t.request({
    method: 'POST',
    url: `/api/groups/${group.id}/agents`,
    payload: { name, role, provider: 'mock', model: 'mock' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function say(body: string): Promise<void> {
  const res = await t.request({
    method: 'POST',
    url: `/api/groups/${group.id}/messages`,
    payload: { body },
  });
  expect(res.statusCode).toBe(201);
}

async function settle(): Promise<void> {
  await t.app.symposium.runner.waitForIdle(group.id);
}

async function chat(): Promise<Message[]> {
  return (await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })).json();
}

/** The chat as "author: body" lines, without the hire announcements. */
async function transcript(): Promise<string[]> {
  const agents: Agent[] = (
    await t.request({ url: `/api/groups/${group.id}/agents?includeFired=true` })
  ).json();
  return (await chat())
    .filter((m) => !m.body.includes('joined as'))
    .map((m) => {
      const who =
        m.authorKind === 'human'
          ? 'CEO'
          : m.authorKind === 'system'
            ? 'system'
            : agents.find((a) => a.id === m.authorAgentId)!.name;
      return `${who}: ${m.body}`;
    });
}

describe('routing', () => {
  it('sends a message without mentions to the lead', async () => {
    await hire('Lea', 'lead', [{ text: 'On it.' }]);
    await hire('Ada', 'worker', [{ text: 'Should not speak' }]);
    await say('Build a shop');
    await settle();
    expect(await transcript()).toEqual(['CEO: Build a shop', 'Lea: On it.']);
  });

  it('sends a message to the agents it mentions, in order, instead of the lead', async () => {
    await hire('Lea', 'lead', [{ text: 'Should not speak' }]);
    await hire('Ada', 'worker', [{ text: 'Ada here.' }]);
    await hire('Bob', 'worker', [{ text: 'Bob here.' }]);
    await say('@Bob and @Ada, status?');
    await settle();
    expect(await transcript()).toEqual([
      'CEO: @Bob and @Ada, status?',
      'Bob: Bob here.',
      'Ada: Ada here.',
    ]);
  });

  it('lets the lead hand work to a worker and the worker report back', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada build the cart.' }, { text: 'Looks done.' }]);
    await hire('Ada', 'worker', [{ text: 'Cart built. @Lea' }]);
    await say('Build a shop');
    await settle();
    expect(await transcript()).toEqual([
      'CEO: Build a shop',
      'Lea: @Ada build the cart.',
      'Ada: Cart built. @Lea',
      'Lea: Looks done.',
    ]);
  });

  it('stops at the round limit and waits for the human', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada again' }]);
    await hire('Ada', 'worker', [{ text: '@Lea again' }]);
    await say('Go');
    await settle();
    const lines = await transcript();
    // Round 0 is the reply to the human; then 3 hand-offs are allowed.
    expect(lines.filter((line) => /^(Lea|Ada):/.test(line))).toHaveLength(4);
    expect(lines.at(-1)).toMatch(/^system: Round limit reached \(3\)/);
  });

  it('uses the group round limit', async () => {
    await t.request({ method: 'PATCH', url: `/api/groups/${group.id}`, payload: { maxRounds: 1 } });
    await hire('Lea', 'lead', [{ text: '@Ada again' }]);
    await hire('Ada', 'worker', [{ text: '@Lea again' }]);
    await say('Go');
    await settle();
    const agentLines = (await transcript()).filter((line) => /^(Lea|Ada):/.test(line));
    expect(agentLines).toHaveLength(2);
  });

  it('ignores mentions of the scribe, of yourself and inside code', async () => {
    await hire('Lea', 'lead', [{ text: 'Me, @Lea, and `@Ada`. @Sam take notes.' }]);
    await hire('Ada', 'worker', [{ text: 'Should not speak' }]);
    await hire('Sam', 'scribe', [{ text: 'Should not speak' }]);
    await say('Plan');
    await settle();
    expect((await transcript()).filter((line) => /^(Ada|Sam):/.test(line))).toEqual([]);
  });

  it('explains what to do when nobody can answer', async () => {
    await hire('Ada', 'worker', [{ text: 'hi' }]);
    await say('Anyone?');
    await settle();
    expect((await transcript()).at(-1)).toMatch(/no lead/);
  });

  it('reports a failed turn and carries on with the others', async () => {
    await hire('Ada', 'worker', [{ text: '', error: 'CLI not logged in' }]);
    await hire('Bob', 'worker', [{ text: 'Bob here.' }]);
    await say('@Ada @Bob status');
    await settle();
    const lines = await transcript();
    expect(lines).toContain('system: Ada could not finish: CLI not logged in');
    expect(lines.at(-1)).toBe('Bob: Bob here.');
    expect(listEvents(t.db, group.id).map((e) => e.kind)).toContain('agent.turn_failed');
  });

  it('lets a new human message interrupt the current run', async () => {
    await hire('Ada', 'worker', [{ text: 'slow answer', delayMs: 5000 }, { text: 'fast answer' }]);
    await say('@Ada do something slow');
    await waitFor(() => t.mocks.get('Ada')!.calls.length === 1);
    await say('@Ada never mind');
    await settle();
    const lines = await transcript();
    expect(lines).not.toContain('Ada: slow answer');
    expect(lines).toContain('system: Stopped the current work to follow your new message.');
    expect(lines.at(-1)).toBe('Ada: fast answer');
  });

  it('stops the team on request', async () => {
    await hire('Ada', 'worker', [{ text: 'slow', delayMs: 5000 }]);
    await say('@Ada go');
    await waitFor(() => t.mocks.get('Ada')!.calls.length === 1);
    const res = await t.request({ method: 'POST', url: `/api/groups/${group.id}/stop` });
    expect(res.json()).toEqual({ stopped: true });
    expect((await transcript()).at(-1)).toBe('system: You stopped the team.');
    const idle = await t.request({ method: 'POST', url: `/api/groups/${group.id}/stop` });
    expect(idle.json()).toEqual({ stopped: false });
  });

  it('gives agents the right context and access', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada build the cart. @Bob build checkout.' }]);
    await hire('Ada', 'worker', [{ text: 'ok' }]);
    await hire('Bob', 'worker', [{ text: 'ok' }]);
    await say('Build a shop');
    await settle();

    const leaTask = t.mocks.get('Lea')!.calls[0]!;
    expect(leaTask.access).toBe('read');
    expect(leaTask.prompt).toContain('Build a shop');

    const adaTask = t.mocks.get('Ada')!.calls[0]!;
    expect(adaTask.access).toBe('edit');
    expect(adaTask.trigger).toBe('@Ada build the cart. @Bob build checkout.');
    // Ada does not see the human's first message, which did not mention her.
    expect(adaTask.prompt).not.toContain('Build a shop');
  });
});

describe('memory and hire proposals', () => {
  it("saves memory notes to the agent's own memory file and hides them from the chat", async () => {
    const ada = await hire('Ada', 'worker', [
      { text: 'Noted.\n```memory\n- CEO wants TypeScript\n```' },
    ]);
    await say('@Ada we use TypeScript');
    await settle();
    expect((await transcript()).at(-1)).toBe('Ada: Noted.');
    expect(await readMemory(t.dataDir, ada.id)).toContain('- CEO wants TypeScript');

    // The note is in her next prompt.
    await say('@Ada next task');
    await settle();
    expect(t.mocks.get('Ada')!.calls[1]!.prompt).toContain('- CEO wants TypeScript');
  });

  it('turns a lead hire proposal into a message the human can approve', async () => {
    await hire('Lea', 'lead', [
      {
        text: 'We need help.\n```hire\n{"name":"Max","role":"worker","provider":"mock","model":"mock"}\n```',
      },
    ]);
    await say('Plan the team');
    await settle();

    const proposal = (await chat()).find((m) => m.meta?.type === 'hire-proposal')!;
    expect(proposal.meta).toMatchObject({ status: 'pending', hire: { name: 'Max' } });
    const approve = await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${proposal.id}/approve-hire`,
    });
    expect(approve.json().meta.status).toBe('approved');
    const agents: Agent[] = (await t.request({ url: `/api/groups/${group.id}/agents` })).json();
    expect(agents.map((a) => a.name)).toContain('Max');

    const again = await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${proposal.id}/reject-hire`,
    });
    expect(again.statusCode).toBe(409);
  });

  it('rejects a proposal without hiring', async () => {
    await hire('Lea', 'lead', [
      { text: '```hire\n{"name":"Max","role":"worker","provider":"mock","model":"mock"}\n```' },
    ]);
    await say('Plan');
    await settle();
    const proposal = (await chat()).find((m) => m.meta?.type === 'hire-proposal')!;
    await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/messages/${proposal.id}/reject-hire`,
    });
    const agents: Agent[] = (await t.request({ url: `/api/groups/${group.id}/agents` })).json();
    expect(agents.map((a) => a.name)).toEqual(['Lea']);
  });

  it('warns about an invalid proposal and ignores proposals from non-leads', async () => {
    await hire('Lea', 'lead', [
      {
        text: '```hire\n{"name":"no spaces allowed","role":"worker","provider":"mock","model":"m"}\n```',
      },
    ]);
    await hire('Ada', 'worker', [
      { text: '```hire\n{"name":"Max","role":"worker","provider":"mock","model":"m"}\n```' },
    ]);
    await say('Plan');
    await settle();
    await say('@Ada hire someone');
    await settle();
    const messages = await chat();
    expect(messages.some((m) => m.meta?.type === 'hire-proposal')).toBe(false);
    expect(messages.some((m) => m.body.includes("can't be used"))).toBe(true);
  });
});
