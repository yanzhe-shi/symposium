import type { Agent, AgentProgress, Message } from '@symposium/engine/protocol';
import { agentStatusLabel, settingsSummary } from './components/TeamPanel.tsx';
import { describe, expect, it } from 'vitest';
import {
  activeAgents,
  activityLine,
  editingAgents,
  groupReducer,
  initialGroupState,
  MAX_PROGRESS,
  MAX_TERMINAL_CHARS,
  mergeMessages,
  mergeProgress,
  queuedCount,
  queuedFor,
  terminalReport,
  workingAgents,
} from './group-state.ts';
import { formatSize } from './text-format.ts';

function message(id: number, body = `message ${id}`): Message {
  return {
    id,
    groupId: 'g1',
    authorKind: 'human',
    authorAgentId: null,
    body,
    meta: null,
    threadId: id,
    round: null,
    createdAt: id,
  };
}

function agent(id: string, firedAt: number | null = null): Agent {
  return {
    id,
    groupId: 'g1',
    name: id,
    provider: 'mock',
    model: 'mock',
    role: 'worker',
    instructions: '',
    options: {},
    settings: { files: 'edit', commands: 'off', allowlist: [], effort: 'default' },
    createdAt: 0,
    firedAt,
  };
}

function did(
  agentId: string,
  at: number,
  summary: string,
  kind: AgentProgress['event']['kind'] = 'read',
): AgentProgress {
  return { agentId, at, event: { kind, summary } };
}

describe('mergeMessages', () => {
  it('adds new messages and keeps them sorted', () => {
    const merged = mergeMessages([message(3)], [message(1), message(2)]);
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('returns the same array when nothing changed (POST response and push)', () => {
    const current = [message(1)];
    expect(mergeMessages(current, [message(1)])).toBe(current);
  });

  it('replaces a message whose content changed, such as a merged diff', () => {
    const updated = { ...message(1), meta: { type: 'notice' as const, level: 'info' as const } };
    expect(mergeMessages([message(1)], [updated])[0]).toBe(updated);
  });

  it('merges a reconnect catch-up that overlaps live events', () => {
    const merged = mergeMessages(
      [message(1), message(2), message(4)],
      [message(2), message(3), message(4), message(5)],
    );
    expect(merged.map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('groupReducer', () => {
  const team = { type: 'agentsLoaded' as const, agents: [agent('a'), agent('b'), agent('old', 5)] };

  it('tracks several agents working at once, each until its own turn ends', () => {
    let state = groupReducer(initialGroupState, team);
    state = groupReducer(state, { type: 'running', running: true });
    state = groupReducer(state, { type: 'activity', agentId: 'a', activity: 'working' });
    state = groupReducer(state, { type: 'activity', agentId: 'b', activity: 'working' });
    expect(workingAgents(state).map((a) => a.id)).toEqual(['a', 'b']);
    expect(activeAgents(state).map((a) => a.id)).toEqual(['a', 'b']);

    state = groupReducer(state, { type: 'activity', agentId: 'a', activity: 'idle' });
    expect(workingAgents(state).map((a) => a.id)).toEqual(['b']);
  });

  it('shows a message as queued for a busy agent until it is delivered', () => {
    let state = groupReducer(initialGroupState, team);
    state = groupReducer(state, { type: 'queue', agentId: 'a', queuedMessageIds: [7, 9] });
    state = groupReducer(state, { type: 'queue', agentId: 'b', queuedMessageIds: [9] });
    expect(queuedCount(state, 'a')).toBe(2);
    expect(queuedFor(state)).toEqual(
      new Map([
        [7, ['a']],
        [9, ['a', 'b']],
      ]),
    );

    state = groupReducer(state, { type: 'delivered', agentId: 'a', messageId: 9 });
    expect(queuedFor(state)).toEqual(
      new Map([
        [7, ['a']],
        [9, ['b']],
      ]),
    );
    // A repeat, or a delivery we never saw queued, changes nothing.
    expect(groupReducer(state, { type: 'delivered', agentId: 'a', messageId: 9 })).toBe(state);

    state = groupReducer(state, { type: 'queue', agentId: 'a', queuedMessageIds: [] });
    state = groupReducer(state, { type: 'delivered', agentId: 'b', messageId: 9 });
    expect(queuedFor(state).size).toBe(0);
    expect(queuedCount(state, 'a')).toBe(0);
  });

  it('replaces activity and queues with a fresh snapshot after a reconnect', () => {
    let state = groupReducer(initialGroupState, team);
    state = groupReducer(state, { type: 'activity', agentId: 'a', activity: 'working' });
    state = groupReducer(state, { type: 'queue', agentId: 'a', queuedMessageIds: [3] });
    state = groupReducer(state, {
      type: 'statusLoaded',
      status: {
        running: true,
        agents: [
          { agentId: 'a', activity: 'idle', queuedMessageIds: [] },
          { agentId: 'b', activity: 'working', queuedMessageIds: [4] },
        ],
      },
    });
    expect(state.running).toBe(true);
    expect(workingAgents(state).map((a) => a.id)).toEqual(['b']);
    expect(queuedFor(state)).toEqual(new Map([[4, ['b']]]));
  });

  it('shows on a card only the settings that differ from the usual', () => {
    const role = (defaultFiles: 'edit' | 'read', defaultCommands: 'ask' | 'off') => ({
      kind: 'worker' as const,
      title: '',
      summary: '',
      defaultFiles,
      defaultCommands,
    });
    const worker = {
      ...agent('a'),
      settings: { ...agent('a').settings, commands: 'ask' as const },
    };
    expect(settingsSummary(worker, role('edit', 'ask'))).toEqual([]);
    const lead = { ...agent('l'), settings: { ...agent('l').settings, effort: 'high' as const } };
    expect(settingsSummary(lead, role('read', 'off'))).toEqual(['files: edit', 'effort: high']);
    const free = { ...worker, settings: { ...worker.settings, commands: 'auto' as const } };
    expect(settingsSummary(free, role('edit', 'ask'))).toEqual(['commands: auto']);
  });

  it('labels an agent card by what the agent is doing', () => {
    expect(agentStatusLabel(false, 0)).toBe('Idle');
    expect(agentStatusLabel(true, 0)).toBe('Working');
    expect(agentStatusLabel(true, 2)).toBe('Working · 2 queued');
    // Waiting for a free slot under the group's cap.
    expect(agentStatusLabel(false, 1)).toBe('1 queued');
  });

  it("builds each agent's activity timeline as its progress arrives", () => {
    let state = groupReducer(initialGroupState, team);
    state = groupReducer(state, { type: 'progress', progress: [did('a', 1, 'read cart.ts')] });
    state = groupReducer(state, {
      type: 'progress',
      progress: [did('a', 2, 'Let me fix the total.', 'text')],
    });
    state = groupReducer(state, {
      type: 'progress',
      progress: [did('a', 3, 'edited cart.ts', 'edit')],
    });
    state = groupReducer(state, { type: 'progress', progress: [did('b', 3, 'read readme.md')] });

    expect(state.progress.a!.map((entry) => entry.event.summary)).toEqual([
      'read cart.ts',
      'Let me fix the total.',
      'edited cart.ts',
    ]);
    // The card shows the tool calls, not what the agent said along the way.
    expect(activityLine(state.progress.a)).toBe('read cart.ts → edited cart.ts');
    expect(activityLine(state.progress.b)).toBe('read readme.md');
    expect(activityLine(undefined)).toBe('');
    expect(activityLine([1, 2, 3, 4, 5].map((n) => did('a', n, `step ${n}`)))).toBe(
      'step 3 → step 4 → step 5',
    );
  });

  it('merges the logged activity with live progress, without repeats or losses', () => {
    const live = mergeProgress({}, [did('a', 5, 'read b.ts'), did('a', 6, 'thinking', 'text')]);
    // The log arrives after a reconnect: it overlaps, lacks the text and holds older entries.
    const logged = [did('a', 2, 'read a.ts'), did('a', 5, 'read b.ts'), did('b', 4, 'read c.ts')];
    const merged = mergeProgress(live, logged);
    expect(merged.a!.map((entry) => entry.event.summary)).toEqual([
      'read a.ts',
      'read b.ts',
      'thinking',
    ]);
    expect(merged.b).toHaveLength(1);
    expect(mergeProgress(merged, logged)).toBe(merged);
    expect(
      groupReducer(
        { ...initialGroupState, progress: merged },
        { type: 'progress', progress: logged },
      ).progress,
    ).toBe(merged);

    const many = Array.from({ length: MAX_PROGRESS + 20 }, (_, n) => did('a', n, `step ${n}`));
    const capped = mergeProgress({}, many).a!;
    expect(capped).toHaveLength(MAX_PROGRESS);
    expect(capped.at(-1)!.event.summary).toBe(`step ${MAX_PROGRESS + 19}`);
  });

  it("keeps each agent's uncommitted changes and tells the Code tab to reload", () => {
    let state = groupReducer(initialGroupState, team);
    const changes = { files: ['cart.ts'], diff: '+x', truncated: false };
    state = groupReducer(state, { type: 'changes', agentId: 'a', changes });
    expect(state.liveChanges).toEqual({ a: changes });
    expect(state.filesVersion).toBe(1);

    state = groupReducer(state, {
      type: 'changes',
      agentId: 'a',
      changes: { files: [], diff: '', truncated: false },
    });
    expect(state.liveChanges.a!.files).toEqual([]);
    state = groupReducer(state, { type: 'filesChanged' });
    expect(state.filesVersion).toBe(3);
  });

  it('offers a worktree to browse only for agents who can edit and are still on the team', () => {
    const reader = { ...agent('r'), settings: { ...agent('r').settings, files: 'read' as const } };
    const state = groupReducer(initialGroupState, {
      type: 'agentsLoaded',
      agents: [agent('a'), reader, agent('old', 5)],
    });
    expect(editingAgents(state).map((a) => a.id)).toEqual(['a']);
  });

  it('follows a command you run yourself, from its first output to its exit', () => {
    const run = {
      runId: 'r1',
      where: 'project',
      folder: 'the project folder',
      command: 'pnpm test',
    };
    // Output can beat the answer that says the run has started.
    let state = groupReducer(initialGroupState, { type: 'terminalOutput', runId: 'r1', text: 'a' });
    state = groupReducer(state, { type: 'terminalStarted', run });
    state = groupReducer(state, { type: 'terminalOutput', runId: 'r1', text: 'b\n' });
    expect(state.terminal).toEqual({ ...run, output: 'ab\n', running: true, exitCode: null });

    // An older run that is still printing does not take over the box.
    expect(groupReducer(state, { type: 'terminalOutput', runId: 'old', text: 'x' })).toBe(state);

    state = groupReducer(state, { type: 'terminalExit', runId: 'r1', exitCode: 1 });
    expect(state.terminal).toMatchObject({ running: false, exitCode: 1, output: 'ab\n' });
    // The command may have changed files, so the Code tab reloads.
    expect(state.filesVersion).toBe(1);

    state = groupReducer(state, {
      type: 'terminalStarted',
      run: { ...run, runId: 'r2', command: 'ls' },
    });
    expect(state.terminal).toMatchObject({ runId: 'r2', output: '', running: true });
    const long = 'x'.repeat(MAX_TERMINAL_CHARS + 10);
    state = groupReducer(state, { type: 'terminalOutput', runId: 'r2', text: `${long}end` });
    expect(state.terminal!.output).toHaveLength(MAX_TERMINAL_CHARS);
    expect(state.terminal!.output.endsWith('end')).toBe(true);
  });

  it('writes up a command for the chat, with the end of its output', () => {
    const run = {
      runId: 'r1',
      where: 'project',
      folder: 'the project folder',
      command: 'pnpm test',
      output: 'line 1\n```\n2 tests failed\n',
      running: false,
      exitCode: 1,
    };
    expect(terminalReport(run)).toBe(
      "I ran `pnpm test` in the project folder (exit code 1):\n\n```\nline 1\n'''\n2 tests failed\n```",
    );
    expect(terminalReport({ ...run, output: '', exitCode: 0 })).toContain(
      '(ok):\n\n```\n(no output)',
    );
    expect(terminalReport({ ...run, exitCode: null })).toContain('(stopped)');
    expect(terminalReport({ ...run, output: 'a'.repeat(50) + 'tail' }, 10)).toContain(
      '```\n…aaaaaatail\n```',
    );
  });

  it('formats file sizes', () => {
    expect(formatSize(812)).toBe('812 B');
    expect(formatSize(4300)).toBe('4.2 KB');
    expect(formatSize(1_400_000)).toBe('1.3 MB');
  });

  it('counts project.md updates and resets', () => {
    const state = groupReducer(initialGroupState, { type: 'projectUpdated' });
    expect(state.projectVersion).toBe(1);
    expect(groupReducer(state, { type: 'reset' })).toEqual(initialGroupState);
  });
});
