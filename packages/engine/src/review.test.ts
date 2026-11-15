import { join } from 'node:path';
import { MockAdapter, type MockReply } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePath } from './git/workspaces.js';
import type { Agent, Group, Message, TeamStatus } from './protocol.js';
import { pickReviewer } from './routing/runner.js';
import { listEvents } from './store/events.js';
import { createTestApp, waitFor, type TestApp } from './testing.js';

const APPROVE = 'Looks right.\n\n```verdict\napprove\n```';
const CART: MockReply = { text: 'Cart built.', files: { 'cart.ts': 'v1\n' } };

describe('pickReviewer', () => {
  const agent = (name: string, role: Agent['role'], provider: Agent['provider'], model: string) =>
    ({ id: name, name, role, provider, model, firedAt: null }) as Agent;
  const ada = agent('Ada', 'worker', 'claude-code', 'sonnet');

  it('prefers a reviewer on another provider, then one on another model', () => {
    const same = agent('Sam', 'reviewer', 'claude-code', 'sonnet');
    const otherModel = agent('Mo', 'reviewer', 'claude-code', 'opus');
    const otherProvider = agent('Gia', 'reviewer', 'antigravity', 'gemini');
    expect(pickReviewer([same, otherModel, otherProvider], ada)).toBe(otherProvider);
    expect(pickReviewer([same, otherModel], ada)).toBe(otherModel);
    expect(pickReviewer([same], ada)).toBe(same);
  });

  it('finds nobody without a reviewer, and never the author or someone who left', () => {
    const lead = agent('Lea', 'lead', 'antigravity', 'gemini');
    const left = { ...agent('Rex', 'reviewer', 'antigravity', 'gemini'), firedAt: 1 };
    const self = agent('Ada', 'reviewer', 'claude-code', 'sonnet');
    expect(pickReviewer([lead, left, self], self)).toBeUndefined();
  });
});

describe('review of every change', () => {
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
    // The plan gate has its own tests.
    await setGroup({ leadAsksFirst: false });
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

  async function chat(): Promise<Message[]> {
    return (await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })).json();
  }

  async function diff(): Promise<Extract<Message['meta'], { type: 'diff' }>> {
    const card = (await chat()).findLast((m) => m.meta?.type === 'diff');
    return card!.meta as Extract<Message['meta'], { type: 'diff' }>;
  }

  const calls = (name: string) => t.mocks.get(name)?.calls ?? [];

  it('has a reviewer judge a change before its report reaches the lead', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Ready to merge.' }]);
    const ada = await hire('Ada', 'worker', [CART]);
    const rex = await hire('Rex', 'reviewer', [{ text: APPROVE }]);
    await say('Build a shop');

    const said = (await chat()).filter((m) => m.authorKind !== 'human' && m.id > 5);
    expect(said.map((m) => m.meta?.type ?? m.body)).toEqual([
      '@Ada build the cart',
      'Cart built.',
      'diff',
      // The verdict block is taken out of the review and put on the diff.
      'Looks right.',
      'Ready to merge.',
    ]);
    const review = said[3]!;
    expect(review.authorAgentId).toBe(rex.id);
    expect((await diff()).review).toEqual({
      reviewerId: rex.id,
      status: 'approved',
      messageId: review.id,
    });

    // The reviewer reads the author's worktree, changes nothing and runs nothing.
    const [task] = calls('Rex');
    expect(task!.access).toBe('read');
    expect(task!.commands).toBe('off');
    expect(task!.workingDirectory).toBe(worktreePath(t.dataDir, group, ada));
    expect(task!.prompt).toContain("Symposium asks you to review Ada's change");
    expect(task!.prompt).toContain('@Ada build the cart');
    expect(task!.prompt).toContain('+v1');
    expect(task!.prompt).toContain('```verdict');

    // Lea is told how reviews work, and reads the verdict with Ada's report.
    const [first, second] = calls('Lea');
    expect(first!.systemPrompt).toContain('Symposium has a reviewer judge every change');
    expect(second!.prompt).toContain(`Review by Rex: approved (message #${review.id})`);
    // The review itself is handed to nobody: one turn each for Ada and Rex.
    expect(calls('Ada')).toHaveLength(1);
    expect(calls('Rex')).toHaveLength(1);
    const event = listEvents(t.db, group.id).find((e) => e.kind === 'review.done');
    expect(event!.detail).toMatchObject({ status: 'approved', authorId: ada.id });
  });

  it('records a call for changes, and does not send the review on by itself', async () => {
    await hire('Ada', 'worker', [CART]);
    const rex = await hire('Rex', 'reviewer', [
      { text: '@Ada the total is never rounded.\n```verdict\nchanges\n```' },
    ]);
    await say('@Ada build the cart');
    expect((await diff()).review).toMatchObject({ reviewerId: rex.id, status: 'changes' });
    // Whoever decides next sends Ada back. The engine does not.
    expect(calls('Ada')).toHaveLength(1);
  });

  it('says so when the reviewer gives no verdict', async () => {
    await hire('Ada', 'worker', [CART]);
    await hire('Rex', 'reviewer', [{ text: 'Hm.' }]);
    await say('@Ada build the cart');
    expect((await diff()).review).toMatchObject({ status: 'unclear' });
  });

  it('reviews nothing that fails the check', async () => {
    await setGroup({ checkCommand: 'exit 1' });
    await hire('Ada', 'worker', [CART]);
    await hire('Rex', 'reviewer', [{ text: APPROVE }]);
    await say('@Ada build the cart');
    const meta = await diff();
    expect(meta.check).toMatchObject({ status: 'failed' });
    expect(meta).not.toHaveProperty('review');
    expect(calls('Rex')).toHaveLength(0);
  });

  it('reviews after a check that passed', async () => {
    await setGroup({ checkCommand: 'test -f cart.ts' });
    await hire('Ada', 'worker', [CART]);
    await hire('Rex', 'reviewer', [{ text: APPROVE }]);
    await say('@Ada build the cart');
    expect(await diff()).toMatchObject({
      check: { status: 'passed' },
      review: { status: 'approved' },
    });
    expect(calls('Rex')[0]!.prompt).toContain('Check `test -f cart.ts`: passed');
  });

  it('reviews nothing when switched off, or without a reviewer', async () => {
    const lea = await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Done.' }]);
    await hire('Ada', 'worker', [CART, { text: 'More.', files: { 'more.ts': 'v1\n' } }]);
    await say('Build a shop');
    expect(await diff()).not.toHaveProperty('review');
    expect(calls('Lea')[0]!.systemPrompt).not.toContain('## Checks and reviews');
    expect(lea.role).toBe('lead');

    expect((await setGroup({ autoReview: false })).json().autoReview).toBe(false);
    await hire('Rex', 'reviewer', [{ text: APPROVE }]);
    await say('@Ada more');
    expect(await diff()).not.toHaveProperty('review');
    expect(calls('Rex')).toHaveLength(0);
  });

  it('hands the report on when the review fails', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Ready to merge.' }]);
    await hire('Ada', 'worker', [CART]);
    await hire('Rex', 'reviewer', [{ text: '', error: 'no credit left' }]);
    await say('Build a shop');
    expect((await diff()).review).toMatchObject({ status: 'failed' });
    expect(calls('Lea')).toHaveLength(2);
    expect(calls('Lea')[1]!.prompt).toContain('Review by Rex: could not be done');
  });

  it('shows the reviewer at work, and stops the review when the reviewer is stopped', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Ready to merge.' }]);
    await hire('Ada', 'worker', [CART]);
    const rex = await hire('Rex', 'reviewer', [{ text: APPROVE, delayMs: 30_000 }]);
    await post('Build a shop');
    await waitFor(() => calls('Rex').length === 1);

    const now: TeamStatus = (await t.request({ url: `/api/groups/${group.id}/run` })).json();
    expect(now.running).toBe(true);
    expect(now.agents.find((a) => a.agentId === rex.id)!.activity).toBe('working');
    expect((await diff()).review).toMatchObject({ status: 'running' });

    const res = await t.request({
      method: 'POST',
      url: `/api/groups/${group.id}/agents/${rex.id}/stop`,
    });
    expect(res.json()).toEqual({ stopped: true });
    await t.app.symposium.runner.waitForIdle(group.id);
    expect((await diff()).review).toMatchObject({ status: 'stopped' });
    // Ada was not stopped, so her report still reaches Lea.
    expect(calls('Lea')).toHaveLength(2);
  });

  it('stops the review with the worker it is about', async () => {
    await hire('Lea', 'lead', [{ text: '@Ada build the cart' }, { text: 'Ready to merge.' }]);
    const ada = await hire('Ada', 'worker', [CART]);
    await hire('Rex', 'reviewer', [{ text: APPROVE, delayMs: 30_000 }]);
    await post('Build a shop');
    await waitFor(() => calls('Rex').length === 1);

    await t.request({ method: 'POST', url: `/api/groups/${group.id}/agents/${ada.id}/stop` });
    await t.app.symposium.runner.waitForIdle(group.id);
    expect((await diff()).review).toMatchObject({ status: 'stopped' });
    // A stopped agent hands nothing on.
    expect(calls('Lea')).toHaveLength(1);
  });

  it('lets one reviewer take two changes one after the other', async () => {
    await hire('Ada', 'worker', [CART]);
    await hire('Bob', 'worker', [{ text: 'Checkout.', files: { 'checkout.ts': 'v1\n' } }]);
    await hire('Rex', 'reviewer', [{ text: APPROVE }]);
    let atOnce = 0;
    let most = 0;
    t.mocks.set(
      'Rex',
      new MockAdapter(async () => {
        atOnce += 1;
        most = Math.max(most, atOnce);
        await new Promise((resolve) => setTimeout(resolve, 50));
        atOnce -= 1;
        return { text: APPROVE };
      }),
    );
    await say('@Ada build the cart. @Bob build the checkout.');
    const reviews = (await chat())
      .filter((m) => m.meta?.type === 'diff')
      .map((m) => (m.meta as { review?: { status: string } }).review?.status);
    expect(reviews).toEqual(['approved', 'approved']);
    expect(most).toBe(1);
  });
});
