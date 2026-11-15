import type { Message, MessageMeta } from '@symposium/engine/protocol';
import { describe, expect, it } from 'vitest';
import { arrivalNotice, pageTitle, stoppedNotice, waitingCount, waitsForYou } from './notify.ts';

let nextId = 1;
function card(meta: object | null): Message {
  return {
    id: nextId++,
    groupId: 'g',
    authorKind: 'system',
    authorAgentId: null,
    body: '',
    meta: meta as MessageMeta | null,
    threadId: 1,
    round: 0,
    createdAt: 0,
  };
}

const plan = (status = 'pending') => card({ type: 'plan', status, leadId: 'lea' });
const diff = (status = 'pending') => card({ type: 'diff', status, agentId: 'ada' });
const command = (status = 'pending') =>
  card({ type: 'command', status, agentId: 'ada', command: 'npm test' });
const proposal = (status = 'pending') =>
  card({ type: 'hire-proposal', status, proposedBy: 'lea', hire: { name: 'Bob' } });
const names: Record<string, string> = { lea: 'Lea', ada: 'Ada' };
const nameOf = (id: string) => names[id] ?? 'Someone';

describe('what waits for the human', () => {
  it('counts cards that are still undecided', () => {
    const messages = [
      card(null),
      card({ type: 'notice', level: 'info' }),
      plan(),
      plan('approved'),
      diff(),
      diff('merged'),
      command('denied'),
      proposal(),
    ];
    expect(messages.map(waitsForYou)).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(waitingCount(messages)).toBe(3);
  });

  it('puts the count in the tab title', () => {
    expect(pageTitle(0)).toBe('Symposium');
    expect(pageTitle(2)).toBe('(2) Symposium');
  });
});

describe('notifications', () => {
  it('tells of a card that holds an agent up', () => {
    expect(arrivalNotice(plan(), 'Shop', nameOf)).toEqual({
      title: 'Shop: a plan waits for your approval',
      body: 'Lea wants to hand out work. Nobody starts before you approve.',
    });
    expect(arrivalNotice(command(), 'Shop', nameOf)).toEqual({
      title: 'Shop: Ada asks to run a command',
      body: 'npm test',
    });
    expect(arrivalNotice(proposal(), 'Shop', nameOf)).toEqual({
      title: 'Shop: a hire waits for your approval',
      body: 'Lea proposes to hire Bob.',
    });
  });

  it('says nothing for a change, a decided card or a plain message', () => {
    expect(arrivalNotice(diff(), 'Shop', nameOf)).toBeUndefined();
    expect(arrivalNotice(plan('approved'), 'Shop', nameOf)).toBeUndefined();
    expect(arrivalNotice(card(null), 'Shop', nameOf)).toBeUndefined();
  });

  it('sums up what waits when the team stops', () => {
    expect(stoppedNotice([diff(), diff('merged')], 'Shop')).toEqual({
      title: 'Shop: the team has stopped working',
      body: '1 change waits for your merge.',
    });
    expect(stoppedNotice([diff(), diff()], 'Shop')?.body).toBe('2 changes wait for your merge.');
    expect(stoppedNotice([card(null)], 'Shop')?.body).toBe('Nothing waits for your approval.');
  });

  it('does not repeat a plan, a command or a hire when the team stops for it', () => {
    expect(stoppedNotice([diff(), plan()], 'Shop')).toBeUndefined();
    expect(stoppedNotice([command()], 'Shop')).toBeUndefined();
    expect(stoppedNotice([proposal(), plan('approved')], 'Shop')).toBeUndefined();
  });
});
