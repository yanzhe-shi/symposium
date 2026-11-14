import { join } from 'node:path';
import { MockAdapter, type MockReply } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMemory } from '../memory.js';
import type { Agent, Group, HireRequest, Message, ServerEvent, TeamStatus } from '../protocol.js';
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

async function status(): Promise<TeamStatus> {
  return (await t.request({ url: `/api/groups/${group.id}/run` })).json();
}

/** Resolves once every named agent has started its first turn. */
async function started(...names: string[]): Promise<void> {
  await waitFor(() => names.every((name) => (t.mocks.get(name)?.calls.length ?? 0) >= 1));
}

function setGroup(changes: Record<string, unknown>) {
  return t.request({ method: 'PATCH', url: `/api/groups/${group.id}`, payload: changes });
}

async function chat(): Promise<Message[]> {
  return (await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })).json();
}

/** The chat as "author: body" lines, without the setup announcements. */
async function transcript(): Promise<string[]> {
  const agents: Agent[] = (
    await t.request({ url: `/api/groups/${group.id}/agents?includeFired=true` })
  ).json();
  return (await chat())
    .filter(
      (m) =>
        !m.body.includes('joined as') &&
        !m.body.includes('left the team') &&
        !m.body.startsWith('Project folder:'),
    )
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

  it('sends a message to the agents it mentions instead of the lead', async () => {
    await hire('Lea', 'lead', [{ text: 'Should not speak' }]);
    await hire('Ada', 'worker', [{ text: 'Ada here.' }]);
    await hire('Bob', 'worker', [{ text: 'Bob here.' }]);
    await say('@Bob and @Ada, status?');
    await settle();
    const lines = await transcript();
    expect(lines[0]).toBe('CEO: @Bob and @Ada, status?');
    expect(lines.slice(1).sort()).toEqual(['Ada: Ada here.', 'Bob: Bob here.']);
  });

  it('returns a reply that mentions nobody to the teammate who asked', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Ready to merge.' }]);
    await hire('Ada', 'worker', [{ text: 'Built it.' }]);
    await say('Build a shop');
    await settle();
    // Ada forgot to mention Lea, and Lea still hears about it. Lea's own unaddressed reply is
    // for the CEO, so Ada is not woken again.
    expect(await transcript()).toEqual([
      'CEO: Build a shop',
      'Lea: @Ada build the cart',
      'Ada: Built it.',
      'Lea: Ready to merge.',
    ]);
    expect(t.mocks.get('Ada')!.calls).toHaveLength(1);
  });

  it('does not return an answer that was itself returned', async () => {
    await hire('Ada', 'worker', [{ text: '@Rita is this right?' }, { text: 'Thanks.' }]);
    await hire('Rita', 'reviewer', [{ text: 'Looks right.' }]);
    await say('@Ada check with Rita');
    await settle();
    // Rita's answer goes back to Ada. Ada's "Thanks." asks for nothing, so it ends there.
    expect(await transcript()).toEqual([
      'CEO: @Ada check with Rita',
      'Ada: @Rita is this right?',
      'Rita: Looks right.',
      'Ada: Thanks.',
    ]);
    expect(t.mocks.get('Rita')!.calls).toHaveLength(1);
  });

  it('returns a reply to nobody when only the CEO asked', async () => {
    await hire('Lea', 'lead', [{ text: 'Should not speak' }]);
    await hire('Ada', 'worker', [{ text: 'Ada here.' }]);
    await say('@Ada status?');
    await settle();
    expect(await transcript()).toEqual(['CEO: @Ada status?', 'Ada: Ada here.']);
  });

  it('counts a returned reply as a round', async () => {
    await setGroup({ maxRounds: 1 });
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }]);
    await hire('Ada', 'worker', [{ text: 'Built it.' }]);
    await say('Build a shop');
    await settle();
    const lines = await transcript();
    expect(lines.slice(0, 3)).toEqual([
      'CEO: Build a shop',
      'Lea: @Ada build the cart',
      'Ada: Built it.',
    ]);
    expect(lines[3]).toMatch(/^system: Round limit reached \(1\)\. Lea is waiting for you/);
    expect(t.mocks.get('Lea')!.calls).toHaveLength(1);
  });

  it('lets two workers the lead assigned in one message work at the same time', async () => {
    // Neither worker can finish until both have started. One after the other would hang.
    let waiting = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    const together = (text: string) =>
      new MockAdapter(async () => {
        waiting += 1;
        if (waiting === 2) release();
        await bothStarted;
        return { text };
      });
    await hire('Lea', 'lead', [
      { text: '@Ada build the cart. @Bob build the list.' },
      { text: 'Noted.' },
    ]);
    await hire('Ada', 'worker');
    await hire('Bob', 'worker');
    t.mocks.set('Ada', together('Cart done.'));
    t.mocks.set('Bob', together('List done.'));
    await say('Build a shop');
    await settle();
    expect((await transcript()).slice(2, 4).sort()).toEqual(['Ada: Cart done.', 'Bob: List done.']);
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
    // Round 0 is the reply to the human; then 6 hand-offs are allowed.
    expect(lines.filter((line) => /^(Lea|Ada):/.test(line))).toHaveLength(7);
    expect(lines.at(-1)).toMatch(/^system: Round limit reached \(6\)\. Ada is waiting for you/);
  });

  it('uses the group round limit', async () => {
    await setGroup({ maxRounds: 1 });
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
    expect(lines).toContain('Bob: Bob here.');
    expect(listEvents(t.db, group.id).map((e) => e.kind)).toContain('agent.turn_failed');
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

  it('tells the lead to start at once when plan approval is switched off', async () => {
    await hire('Lea', 'lead', [{ text: 'ok' }]);
    await say('Build a shop');
    await settle();
    await setGroup({ leadAsksFirst: false });
    await say('Add a cart');
    await settle();

    const [asking, starting] = t.mocks.get('Lea')!.calls;
    // The built-in lead role keeps its approval line in one list with the others.
    expect(asking!.systemPrompt).toMatch(
      /## How you work\n\n- When the CEO gives you a new goal.*ask the CEO to approve it.*\n- Assign work/,
    );
    expect(asking!.systemPrompt).not.toContain('ask-first');
    expect(starting!.systemPrompt).toContain('## How you work\n\n- Assign work');
    expect(starting!.systemPrompt).not.toContain('ask the CEO to approve it');
    expect(starting!.systemPrompt).toContain('Start right away');
  });
});

describe('non-blocking chat', () => {
  it('lets two workers work at the same time', async () => {
    await hire('Ada', 'worker', [{ text: 'Ada done.', delayMs: 300 }]);
    await hire('Bob', 'worker', [{ text: 'Bob done.', delayMs: 300 }]);
    await say('@Ada build the cart. @Bob build the checkout.');
    await started('Ada', 'Bob');

    // Both turns are in progress before either has replied.
    expect((await transcript()).filter((line) => /^(Ada|Bob):/.test(line))).toEqual([]);
    const now = await status();
    expect(now.running).toBe(true);
    expect(now.agents.map((agent) => agent.activity)).toEqual(['working', 'working']);

    await settle();
    expect((await transcript()).slice(1).sort()).toEqual(['Ada: Ada done.', 'Bob: Bob done.']);
    expect((await status()).running).toBe(false);
  });

  it('gives a busy agent new messages in its next turn, together, without cancelling anything', async () => {
    const ada = await hire('Ada', 'worker', [
      { text: 'Cart done.', delayMs: 300 },
      { text: 'Both noted.' },
    ]);
    await say('@Ada build the cart');
    await started('Ada');
    await say('@Ada use euros');
    await say('@Ada and add a coupon field');

    const waiting = (await chat()).filter((m) => /euros|coupon/.test(m.body)).map((m) => m.id);
    expect((await status()).agents).toEqual([
      { agentId: ada.id, activity: 'working', queuedMessageIds: waiting },
    ]);

    await settle();
    expect((await transcript()).filter((line) => !line.startsWith('CEO:'))).toEqual([
      'Ada: Cart done.',
      'Ada: Both noted.',
    ]);
    const calls = t.mocks.get('Ada')!.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal?.aborted).toBe(false);
    expect(calls[1]!.prompt).toContain('New messages since you started:');
    expect(calls[1]!.prompt).toContain('use euros');
    expect(calls[1]!.prompt).toContain('add a coupon field');
    expect(calls[1]!.trigger).toBe('@Ada use euros\n\n@Ada and add a coupon field');
    expect((await status()).agents[0]!.queuedMessageIds).toEqual([]);
  });

  it('tells the UI when a message is waiting and when it is delivered', async () => {
    const events: ServerEvent[] = [];
    const hub = t.app.symposium.ctx.hub;
    const broadcast = hub.broadcast.bind(hub);
    hub.broadcast = (groupId, event) => {
      events.push(event);
      broadcast(groupId, event);
    };
    const ada = await hire('Ada', 'worker', [{ text: 'One.', delayMs: 200 }, { text: 'Two.' }]);
    await say('@Ada first');
    await started('Ada');
    await say('@Ada second');
    await settle();

    const second = (await chat()).find((m) => m.body === '@Ada second')!;
    const relevant = events.filter(
      (event) => event.type === 'agent.queue' || event.type === 'message.delivered',
    );
    // The first message started at once, so only the second was ever shown as waiting.
    expect(relevant).toEqual([
      { type: 'agent.queue', agentId: ada.id, queuedMessageIds: [second.id] },
      { type: 'message.delivered', messageId: second.id, agentId: ada.id },
      { type: 'agent.queue', agentId: ada.id, queuedMessageIds: [] },
    ]);
    expect(events.filter((event) => event.type === 'run.status')).toEqual([
      { type: 'run.status', running: true },
      { type: 'run.status', running: false },
    ]);
  });

  it('counts rounds per thread, so one thread at its limit does not hold up another', async () => {
    await setGroup({ maxRounds: 1 });
    await hire('Lea', 'lead', [{ text: '@Ada again' }]);
    await hire('Ada', 'worker', [{ text: '@Lea again' }]);
    await hire('Bob', 'worker', [{ text: 'Bob here.' }]);
    await say('Go');
    await settle();
    await say('@Bob are you there?');
    await settle();

    const messages = await chat();
    const first = messages.find((m) => m.body === 'Go')!;
    const second = messages.find((m) => m.body === '@Bob are you there?')!;
    expect(first.threadId).toBe(first.id);
    expect(second.threadId).toBe(second.id);

    const inFirst = messages.filter((m) => m.threadId === first.id && m.id !== first.id);
    expect(inFirst.map((m) => [m.body.slice(0, 11), m.round])).toEqual([
      ['@Ada again', 0],
      ['@Lea again', 1],
      ['Round limit', null],
    ]);
    const bob = messages.find((m) => m.body === 'Bob here.')!;
    expect([bob.threadId, bob.round]).toEqual([second.id, 0]);
  });

  it('keeps to the cap on agents working at once', async () => {
    await setGroup({ maxParallel: 2 });
    await hire('Ada', 'worker', [{ text: 'Ada done.', delayMs: 200 }]);
    await hire('Bob', 'worker', [{ text: 'Bob done.', delayMs: 200 }]);
    const cy = await hire('Cy', 'worker', [{ text: 'Cy done.' }]);
    await say('@Ada @Bob @Cy go');
    await started('Ada', 'Bob');

    expect(t.mocks.get('Cy')!.calls).toHaveLength(0);
    const waiting = (await status()).agents.find((agent) => agent.agentId === cy.id)!;
    expect(waiting.activity).toBe('idle');
    expect(waiting.queuedMessageIds).toHaveLength(1);

    await settle();
    expect((await transcript()).slice(1).sort()).toEqual([
      'Ada: Ada done.',
      'Bob: Bob done.',
      'Cy: Cy done.',
    ]);
  });

  it('starts waiting agents when the cap is raised', async () => {
    await setGroup({ maxParallel: 1 });
    await hire('Ada', 'worker', [{ text: 'Ada done.', delayMs: 300 }]);
    await hire('Bob', 'worker', [{ text: 'Bob done.', delayMs: 300 }]);
    await say('@Ada @Bob go');
    await started('Ada');
    expect(t.mocks.get('Bob')!.calls).toHaveLength(0);
    await setGroup({ maxParallel: 2 });
    await started('Bob');
    expect(t.mocks.get('Ada')!.calls[0]!.signal?.aborted).toBe(false);
  });
});

describe('stopping', () => {
  it('stops the whole team on request and empties every inbox', async () => {
    await hire('Ada', 'worker', [{ text: 'slow', delayMs: 5000 }]);
    await say('@Ada go');
    await started('Ada');
    await say('@Ada one more thing');
    const res = await t.request({ method: 'POST', url: `/api/groups/${group.id}/stop` });
    expect(res.json()).toEqual({ stopped: true });
    const lines = await transcript();
    expect(lines.at(-1)).toBe('system: You stopped the team.');
    expect(lines).not.toContain('Ada: slow');
    expect(t.mocks.get('Ada')!.calls).toHaveLength(1);
    expect(await status()).toMatchObject({ running: false });
    expect(listEvents(t.db, group.id).map((e) => e.kind)).toContain('team.stopped');

    const idle = await t.request({ method: 'POST', url: `/api/groups/${group.id}/stop` });
    expect(idle.json()).toEqual({ stopped: false });
  });

  it('stops one agent while the others carry on', async () => {
    const ada = await hire('Ada', 'worker', [{ text: 'Ada done.', delayMs: 5000 }]);
    await hire('Bob', 'worker', [{ text: 'Bob done.', delayMs: 150 }]);
    await say('@Ada @Bob go');
    await started('Ada', 'Bob');
    await say('@Ada more for later');

    const res = await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/agents/${ada.id}/stop`,
    });
    expect(res.json()).toEqual({ stopped: true });
    await settle();

    const lines = await transcript();
    expect(lines).toContain('system: You stopped Ada.');
    expect(lines).toContain('Bob: Bob done.');
    expect(lines.some((line) => line.startsWith('Ada:'))).toBe(false);
    // Her inbox was emptied too, so the waiting message did not start a new turn.
    expect(t.mocks.get('Ada')!.calls).toHaveLength(1);

    const unknown = await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/agents/nope/stop`,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('stops the agents a /stop message mentions, or everyone', async () => {
    await hire('Ada', 'worker', [{ text: 'Ada done.', delayMs: 5000 }]);
    await hire('Bob', 'worker', [{ text: 'Bob done.', delayMs: 5000 }]);
    await say('@Ada @Bob go');
    await started('Ada', 'Bob');

    await say('/stop @Ada');
    await waitFor(() => t.mocks.get('Ada')!.calls[0]!.signal!.aborted);
    expect(t.mocks.get('Bob')!.calls[0]!.signal!.aborted).toBe(false);

    await say('/stop');
    await waitFor(() => t.mocks.get('Bob')!.calls[0]!.signal!.aborted);
    await settle();
    const lines = await transcript();
    expect(lines).toContain('system: You stopped Ada.');
    expect(lines.at(-1)).toBe('system: You stopped the team.');
    expect(lines.some((line) => /^(Ada|Bob):/.test(line))).toBe(false);
    // A command is never handed to an agent as work.
    expect(t.mocks.get('Ada')!.calls).toHaveLength(1);
    expect(t.mocks.get('Bob')!.calls).toHaveLength(1);
  });

  it('says so when /stop finds nothing to stop', async () => {
    await hire('Ada', 'worker');
    await say('/stop');
    await say('/stop @Ada');
    await waitFor(
      () => t.db.prepare("SELECT 1 FROM messages WHERE body LIKE 'Ada was%'").get() !== undefined,
    );
    const lines = await transcript();
    expect(lines).toContain('system: Nothing was running.');
    expect(lines).toContain('system: Ada was not working on anything.');
    expect(t.mocks.get('Ada')).toBeUndefined();
  });

  it('interrupts an agent with /now and restarts it on that message', async () => {
    await hire('Ada', 'worker', [
      { text: 'slow answer', delayMs: 5000 },
      { text: 'Header fixed.' },
    ]);
    await hire('Bob', 'worker', [{ text: 'Bob done.', delayMs: 200 }]);
    await say('@Ada do something slow. @Bob do something else.');
    await started('Ada', 'Bob');
    await say('@Ada a small note for later');
    await say('/now @Ada fix the header first');
    await settle();

    const lines = await transcript();
    expect(lines).not.toContain('Ada: slow answer');
    expect(lines).toContain('system: You interrupted Ada with an urgent message.');
    expect(lines).toContain('Ada: Header fixed.');
    // Bob was not touched.
    expect(lines).toContain('Bob: Bob done.');

    const calls = t.mocks.get('Ada')!.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(calls[1]!.prompt).toContain('interrupted your previous turn');
    // What was already waiting comes along in the same turn.
    expect(calls[1]!.trigger).toContain('fix the header first');
    expect(calls[1]!.trigger).toContain('a small note for later');
  });

  it('treats /now for an idle agent as an ordinary message', async () => {
    await hire('Ada', 'worker', [{ text: 'On it.' }]);
    await say('/now @Ada fix the header');
    await settle();
    expect((await transcript()).slice(1)).toEqual(['Ada: On it.']);
    expect(t.mocks.get('Ada')!.calls[0]!.prompt).not.toContain('interrupted');
  });

  it('stops an agent who is fired mid-turn', async () => {
    const ada = await hire('Ada', 'worker', [{ text: 'slow', delayMs: 5000 }]);
    await say('@Ada go');
    await started('Ada');
    await t.request({ method: 'DELETE', url: `/api/groups/${group.id}/agents/${ada.id}` });
    await settle();
    expect(t.mocks.get('Ada')!.calls[0]!.signal?.aborted).toBe(true);
    expect((await transcript()).some((line) => line.startsWith('Ada:'))).toBe(false);
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
