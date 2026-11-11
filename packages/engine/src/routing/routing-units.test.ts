import { describe, expect, it } from 'vitest';
import type { Agent, Group, Message } from '../protocol.js';
import { parseMentions } from './mentions.js';
import { buildPrompt, buildSystemPrompt, visibleHistory, type PromptInput } from './prompt.js';
import { parseReplyBlocks } from './reply-blocks.js';

function agent(name: string, role: Agent['role'] = 'worker'): Agent {
  return {
    id: `id-${name}`,
    groupId: 'g',
    name,
    provider: 'mock',
    model: 'mock',
    role,
    instructions: '',
    options: {},
    createdAt: 0,
    firedAt: null,
  };
}

const ada = agent('Ada');
const bob = agent('Bob');
const lea = agent('Lea', 'lead');
const team = [lea, ada, bob];

describe('parseMentions', () => {
  it('finds mentions in order of first appearance, ignoring case and repeats', () => {
    expect(parseMentions('@bob then @Ada, and @BOB again', team)).toEqual([bob, ada]);
  });

  it('ignores unknown names, emails, paths and code', () => {
    const text = [
      'mail ada@example.com',
      'see docs/@Ada',
      '`@Ada` in code',
      '```\n@Bob in a block\n```',
      '@Nobody here',
    ].join('\n');
    expect(parseMentions(text, team)).toEqual([]);
  });

  it('accepts punctuation after a name', () => {
    expect(parseMentions('(@Ada) and @Bob: and @Lea-', team)).toEqual([ada, bob, lea]);
  });

  it('does not match a longer name', () => {
    expect(parseMentions('@Adam', team)).toEqual([]);
  });
});

describe('parseReplyBlocks', () => {
  it('removes memory and hire blocks and collects their contents', () => {
    const reply = [
      'Plan ready.',
      '```memory',
      '- CEO likes tests',
      '```',
      'We also need a backend dev.',
      '```hire',
      '{"name": "Max", "role": "worker", "provider": "mock", "model": "mock"}',
      '```',
      'Done.',
    ].join('\n');
    const parsed = parseReplyBlocks(reply);
    expect(parsed.text).toBe('Plan ready.\n\nWe also need a backend dev.\n\nDone.');
    expect(parsed.memoryNotes).toEqual(['- CEO likes tests']);
    expect(parsed.hireProposals).toEqual([
      { name: 'Max', role: 'worker', provider: 'mock', model: 'mock' },
    ]);
  });

  it('reports a hire block that is not JSON and keeps ordinary code blocks', () => {
    const parsed = parseReplyBlocks('```hire\nnot json\n```\n```ts\nconst x = 1;\n```');
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.text).toContain('const x = 1;');
  });
});

describe('prompt context', () => {
  const group: Group = {
    id: 'g',
    name: 'Shop',
    folderPath: '/tmp/shop',
    baseBranch: 'main',
    maxRounds: 3,
    createdAt: 0,
  };
  let nextId = 1;
  function message(body: string, author?: Agent): Message {
    return {
      id: nextId++,
      groupId: 'g',
      authorKind: author ? 'agent' : 'human',
      authorAgentId: author?.id ?? null,
      body,
      meta: null,
      createdAt: 0,
    };
  }
  const history = [
    message('Build a shop'),
    message('@Ada please do the cart', lea),
    message('@Bob please do the checkout', lea),
    message('Cart done. @Lea', ada),
  ];

  function input(who: Agent, trigger: Message): PromptInput {
    return {
      group,
      agent: who,
      team,
      everyone: team,
      roleText: '# Role',
      access: who.role === 'worker' ? 'edit' : 'read',
      projectMd: '# Shop',
      memory: '- remember me',
      history,
      trigger,
    };
  }

  it('shows the lead the whole conversation', () => {
    expect(visibleHistory(input(lea, history[3]!))).toHaveLength(4);
  });

  it('shows other agents only messages that concern them', () => {
    const seen = visibleHistory(input(ada, history[1]!)).map((m) => m.body);
    expect(seen).toEqual(['@Ada please do the cart', 'Cart done. @Lea']);
    expect(seen.join()).not.toContain('checkout');
  });

  it('includes project.md, memory, the team and the turn instructions', () => {
    const prompt = buildPrompt(input(ada, history[1]!));
    expect(prompt).toContain('# Shop');
    expect(prompt).toContain('- remember me');
    expect(prompt).toContain('Message #2 from Lea (lead) is addressed to you');

    const system = buildSystemPrompt(input(ada, history[1]!));
    expect(system).toContain('You are Ada, the worker');
    expect(system).toContain('- Bob: worker');
    expect(system).toContain('own git worktree');
    expect(system).not.toContain('Proposing hires');
    expect(buildSystemPrompt(input(lea, history[0]!))).toContain('Proposing hires');
  });
});
