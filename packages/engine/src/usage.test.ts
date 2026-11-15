import { join } from 'node:path';
import { MockAdapter, type MockReply } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Group, GroupUsage } from './protocol.js';
import { createTestApp, type TestApp } from './testing.js';

describe('usage', () => {
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
    await t.request({
      method: 'PATCH',
      url: `/api/groups/${group.id}`,
      payload: { leadAsksFirst: false },
    });
  });
  afterEach(async () => {
    await t.close();
  });

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

  async function say(body: string): Promise<void> {
    await t.request({ method: 'POST', url: `/api/groups/${group.id}/messages`, payload: { body } });
    await t.app.symposium.runner.waitForIdle(group.id);
  }

  async function usage(): Promise<GroupUsage> {
    return (await t.request({ url: `/api/groups/${group.id}/usage` })).json();
  }

  it('is empty before anyone has worked', async () => {
    expect(await usage()).toEqual({
      total: { turns: 0, failedTurns: 0, durationMs: 0, costUsd: null, pricedTurns: 0 },
      agents: [],
      threads: [],
    });
  });

  it('adds up turns, time and reported cost per agent and per task', async () => {
    const lea = await hire('Lea', 'lead', [
      { text: '@Ada build the cart', costUsd: 0.02 },
      { text: 'Ready to merge.', costUsd: 0.01 },
      { text: 'Noted.', costUsd: 0.04 },
    ]);
    // Ada's provider reports no cost, as Antigravity and API providers do not.
    const ada = await hire('Ada', 'worker', [{ text: 'Built it.', delayMs: 30 }]);
    await say('Build a shop\nwith a cart');
    await say('Thanks');

    const result = await usage();
    expect(result.total).toMatchObject({ turns: 4, failedTurns: 0, pricedTurns: 3 });
    expect(result.total.costUsd).toBeCloseTo(0.07);
    expect(result.total.durationMs).toBeGreaterThanOrEqual(30);

    const byAgent = Object.fromEntries(result.agents.map((agent) => [agent.agentId, agent]));
    expect(byAgent[lea.id]).toMatchObject({ turns: 3, pricedTurns: 3 });
    expect(byAgent[lea.id]!.costUsd).toBeCloseTo(0.07);
    // No price was reported for Ada's turn: that is "unknown", not "free".
    expect(byAgent[ada.id]).toMatchObject({ turns: 1, costUsd: null, pricedTurns: 0 });

    // Newest task first, named after the first line of the human's message.
    expect(result.threads.map((thread) => thread.title)).toEqual(['Thanks', 'Build a shop']);
    const [thanks, shop] = result.threads;
    expect(thanks).toMatchObject({ turns: 1, agentIds: [lea.id] });
    expect(thanks!.costUsd).toBeCloseTo(0.04);
    expect(shop).toMatchObject({ turns: 3, pricedTurns: 2 });
    expect(shop!.agentIds.sort()).toEqual([ada.id, lea.id].sort());
    expect(shop!.costUsd).toBeCloseTo(0.03);
  });

  it('counts failed turns, reviews and the scribe', async () => {
    await hire('Ada', 'worker', [
      { text: 'Cart.', files: { 'cart.ts': 'v1\n' } },
      { text: '', error: 'no credit left' },
    ]);
    const rex = await hire('Rex', 'reviewer', [
      { text: 'Fine.\n```verdict\napprove\n```', costUsd: 0.05 },
    ]);
    const sam = await hire('Sam', 'scribe', [{ text: '# Shop\n\nA cart.', costUsd: 0.001 }]);
    await say('@Ada build the cart');
    await say('@Ada and now the checkout');

    const result = await usage();
    const byAgent = Object.fromEntries(result.agents.map((agent) => [agent.agentId, agent]));
    // The review the engine asked for is a turn of Rex's, in the task it belongs to.
    expect(byAgent[rex.id]).toMatchObject({ turns: 1, costUsd: 0.05 });
    expect(byAgent[sam.id]!.turns).toBeGreaterThanOrEqual(1);
    expect(result.total.failedTurns).toBe(1);
    const [checkout, cart] = result.threads;
    expect(checkout).toMatchObject({
      title: '@Ada and now the checkout',
      turns: 1,
      failedTurns: 1,
    });
    expect(cart).toMatchObject({ turns: 2, costUsd: 0.05 });
  });
});
