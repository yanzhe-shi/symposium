import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockAdapter, type MockReply } from '@symposium/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Group, Message } from './protocol.js';
import { unwrapMarkdown } from './scribe.js';
import { createTestApp, waitFor, type TestApp } from './testing.js';

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

async function chat(): Promise<Message[]> {
  return (await t.request({ url: `/api/groups/${group.id}/messages?limit=500` })).json();
}

const projectFile = () => readFileSync(join(folder, 'project.md'), 'utf8');

describe('scribe', () => {
  it('starts every group with a project.md', () => {
    expect(projectFile()).toContain('# Shop');
  });

  it('updates project.md after a run, with only the new messages', async () => {
    await hire('Lea', 'lead', [{ text: 'Plan: cart, then checkout.' }]);
    await hire('Sam', 'scribe', [
      { text: '```markdown\n# Shop\n\n## Plan\n\n- Cart\n- Checkout\n```' },
      { text: '# Shop\n\n## Status\n\nCart started.' },
    ]);
    await say('Build a shop');

    expect(projectFile()).toBe('# Shop\n\n## Plan\n\n- Cart\n- Checkout\n');
    const task = t.mocks.get('Sam')!.calls[0]!;
    expect(task.access).toBe('none');
    expect(task.prompt).toContain('Plan: cart, then checkout.');
    expect(task.prompt).toContain('# Current project.md');
    expect((await chat()).at(-1)?.body).toBe('Sam updated project.md.');

    await say('Start on the cart');
    const second = t.mocks.get('Sam')!.calls[1]!;
    expect(second.prompt).toContain('Start on the cart');
    expect(second.prompt).not.toContain('Build a shop');
    expect(projectFile()).toContain('Cart started.');
  });

  it('runs when the human mentions the scribe directly', async () => {
    await hire('Sam', 'scribe', [{ text: '# Shop\n\nGoal: sell socks.' }]);
    await say('@Sam note that the goal is to sell socks');
    expect(projectFile()).toContain('Goal: sell socks.');
  });

  it('keeps project.md when the scribe fails', async () => {
    await hire('Lea', 'lead', [{ text: 'ok' }]);
    await hire('Sam', 'scribe', [{ text: '   ' }]);
    const before = projectFile();
    await say('Hello');
    expect(projectFile()).toBe(before);
    expect((await chat()).at(-1)?.body).toMatch(
      /Sam could not update project.md: the reply was empty/,
    );
  });

  it('gives every agent the current project.md', async () => {
    await hire('Lea', 'lead', [{ text: 'ok' }]);
    await say('Hello');
    expect(t.mocks.get('Lea')!.calls[0]!.prompt).toContain('# Shop');
  });

  it('waits until the whole team is idle before it runs', async () => {
    await hire('Ada', 'worker', [{ text: 'Cart done.', delayMs: 150 }]);
    await hire('Bob', 'worker', [{ text: 'Checkout done.', delayMs: 300 }]);
    await hire('Sam', 'scribe', [{ text: '# Shop\n\nCart and checkout are done.' }]);
    await say('@Ada build the cart. @Bob build the checkout.');

    const sam = t.mocks.get('Sam')!;
    expect(sam.calls).toHaveLength(1);
    expect(sam.calls[0]!.prompt).toContain('Cart done.');
    expect(sam.calls[0]!.prompt).toContain('Checkout done.');
  });

  it('strips a fence around the whole reply only', () => {
    expect(unwrapMarkdown('```md\n# A\n```')).toBe('# A');
    expect(unwrapMarkdown('# A\n\n```ts\nx\n```')).toBe('# A\n\n```ts\nx\n```');
  });
});

describe('document routes', () => {
  it('reads and edits project.md', async () => {
    const read = await t.request({ url: `/api/groups/${group.id}/project` });
    expect(read.json().content).toContain('# Shop');
    const write = await t.request({
      method: 'PUT',
      url: `/api/groups/${group.id}/project`,
      payload: { content: '# Edited by hand' },
    });
    expect(write.json().content).toBe('# Edited by hand\n');
    expect(projectFile()).toBe('# Edited by hand\n');
  });

  it("reads and edits an agent's memory", async () => {
    const ada = await hire('Ada', 'worker', [{ text: 'Saved.\n```memory\n- likes tea\n```' }]);
    await say('@Ada remember tea');
    const url = `/api/groups/${group.id}/agents/${ada.id}/memory`;
    expect((await t.request({ url })).json().content).toContain('- likes tea');

    await t.request({ method: 'PUT', url, payload: { content: '- likes coffee\n' } });
    expect((await t.request({ url })).json().content).toBe('- likes coffee\n');
    expect(
      (await t.request({ url: `/api/groups/${group.id}/agents/nope/memory` })).statusCode,
    ).toBe(404);
  });
});

describe('scribe timing', () => {
  it('runs once after the chat has been quiet for a while', async () => {
    const quiet = await createTestApp({ scribeDelayMs: 150 });
    try {
      const shop: Group = (
        await quiet.request({
          method: 'POST',
          url: '/api/groups',
          payload: { name: 'Shop', folderPath: join(quiet.workDir, 'shop') },
        })
      ).json();
      const post = (url: string, payload: object) =>
        quiet.request({ method: 'POST', url, payload });
      const sam = new MockAdapter([{ text: '# Shop\n\nTwo things happened.' }]);
      quiet.mocks.set('Sam', sam);
      for (const [name, role] of [
        ['Lea', 'lead'],
        ['Sam', 'scribe'],
      ]) {
        await post(`/api/groups/${shop.id}/agents`, {
          name,
          role,
          provider: 'mock',
          model: 'mock',
        });
      }

      // The second message arrives during the quiet period, which starts over.
      await post(`/api/groups/${shop.id}/messages`, { body: 'First thing' });
      await waitFor(() => quiet.mocks.get('Lea')?.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(sam.calls).toHaveLength(0);
      await post(`/api/groups/${shop.id}/messages`, { body: 'Second thing' });
      await quiet.app.symposium.runner.waitForIdle(shop.id);

      expect(sam.calls).toHaveLength(1);
      expect(sam.calls[0]!.prompt).toContain('First thing');
      expect(sam.calls[0]!.prompt).toContain('Second thing');
    } finally {
      await quiet.close();
    }
  });
});
