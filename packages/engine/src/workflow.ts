import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { postMessage, postNotice, setMessageMeta } from './chat.js';
import { runCheck } from './checks.js';
import type { CommandApprovals } from './commands/approvals.js';
import type { AppContext } from './context.js';
import { badRequest, conflict, notFound } from './errors.js';
import { ignoreAgentFiles } from './git/repository.js';
import {
  commitWork,
  discardWork,
  ensureWorktree,
  mergeWork,
  pendingDiff,
  removeWorktrees,
  uncommittedChanges,
} from './git/workspaces.js';
import { memoryPath } from './memory.js';
import type { Agent, Group, Message } from './protocol.js';
import type { RunnerHooks, Workspace } from './routing/runner.js';
import { updateProjectFile } from './scribe.js';
import { getAgent } from './store/agents.js';
import { logEvent } from './store/events.js';
import { getGroup } from './store/groups.js';
import { getMessage, listMessagesSince } from './store/messages.js';
import { refreshWorkspaceFile, workspaceFilePath } from './vscode.js';

/** Pending diff messages for an agent, newest last. */
function pendingDiffMessages(ctx: AppContext, group: Group, agentId: string): Message[] {
  return listMessagesSince(ctx.db, group.id, 0).filter(
    (message) =>
      message.meta?.type === 'diff' &&
      message.meta.agentId === agentId &&
      message.meta.status === 'pending',
  );
}

/**
 * Commits a worker's changes on its branch and shows the branch's pending diff in the chat.
 * Returns the diff's message, or nothing when the turn changed no files.
 */
async function recordWork(
  ctx: AppContext,
  group: Group,
  agent: Agent,
  workspace: Workspace,
  reply: Message,
): Promise<Message | undefined> {
  if (!workspace.branch) return;
  const commit = await commitWork(
    { path: workspace.cwd, branch: workspace.branch },
    agent,
    reply.body,
  );
  if (!commit) return;
  logEvent(ctx.db, {
    groupId: group.id,
    agentId: agent.id,
    kind: 'git.commit',
    detail: { branch: workspace.branch, commit },
  });

  const diff = await pendingDiff(group, agent);
  if (!diff) return;
  // The new diff covers everything on the branch, so older pending ones are out of date.
  for (const old of pendingDiffMessages(ctx, group, agent.id)) {
    if (old.meta?.type === 'diff') setMessageMeta(ctx, old, { ...old.meta, status: 'superseded' });
  }
  const count = diff.files.length;
  return postMessage(ctx, {
    groupId: group.id,
    authorKind: 'system',
    body: `${agent.name} changed ${count} file${count === 1 ? '' : 's'} on ${workspace.branch}. Review the diff, then merge it into ${group.baseBranch} or discard it.`,
    meta: {
      type: 'diff',
      status: 'pending',
      agentId: agent.id,
      branch: workspace.branch,
      baseBranch: group.baseBranch!,
      ...diff,
    },
  });
}

/**
 * Runs the group's check command on a worker's change, in its worktree, and writes the result
 * on the diff's card. The human chose the command; the engine runs it, never the agent.
 */
async function checkWork(
  ctx: AppContext,
  group: Group,
  agent: Agent,
  workspace: Workspace,
  card: Message,
  signal: AbortSignal,
): Promise<void> {
  // Read now, not at the start of the turn: the human may have changed it since.
  const command = getGroup(ctx.db, group.id)?.checkCommand.trim();
  if (!command || card.meta?.type !== 'diff') return;
  setMessageMeta(ctx, card, {
    ...card.meta,
    check: { command, status: 'running', exitCode: null, output: '', durationMs: 0 },
  });
  const check = await runCheck(command, workspace.cwd, { signal });
  logEvent(ctx.db, {
    groupId: group.id,
    agentId: agent.id,
    kind: 'check.run',
    detail: {
      command,
      status: check.status,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      commit: card.meta.commit,
    },
  });
  // The card may have been merged, discarded or replaced while the check ran.
  const latest = getMessage(ctx.db, card.id);
  if (latest?.meta?.type === 'diff') setMessageMeta(ctx, latest, { ...latest.meta, check });
}

/**
 * Agents work in parallel, but they share one git repository. Symposium's own git steps for a
 * group (opening worktrees, committing, merging, discarding) run one at a time, in order.
 */
const gitQueues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(groupId: string, step: () => Promise<T>): Promise<T> {
  const previous = gitQueues.get(groupId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(step);
  gitQueues.set(groupId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (gitQueues.get(groupId) === next) gitQueues.delete(groupId);
    });
  return next;
}

export function createRunnerHooks(ctx: AppContext, approvals: CommandApprovals): RunnerHooks {
  return {
    async prepareWorkspace(group, agent) {
      // Whoever may edit does so in their own worktree, whatever their role. Everyone else
      // reads the project folder.
      if (agent.settings.files !== 'edit' || !group.baseBranch) return { cwd: group.folderPath! };
      const worktree = await oneAtATime(group.id, async () => {
        // Checked before every turn that can edit: it is one small file, and it must hold
        // before anything is committed.
        await ignoreAgentFiles(group.folderPath!).catch(() => undefined);
        return ensureWorktree(ctx.dataDir, group, agent);
      });
      if (worktree.warning) postNotice(ctx, group.id, worktree.warning, 'warning');
      // A first turn creates the worktree, which then belongs in the VS Code workspace.
      refreshWorkspaceFile(ctx, group);
      return { cwd: worktree.path, branch: worktree.branch };
    },
    afterTurn: async (group, agent, workspace, reply, signal) => {
      const card = await oneAtATime(group.id, () =>
        recordWork(ctx, group, agent, workspace, reply),
      );
      // Outside the git queue: a slow test run must not hold up the other agents' commits.
      if (card) await checkWork(ctx, group, agent, workspace, card, signal);
    },
    onIdle: async (group, signal) => {
      await updateProjectFile(ctx, group, signal);
    },
    // Only looks, so it does not wait in the queue behind the git steps above.
    liveChanges: async (_group, _agent, workspace) =>
      workspace.branch ? uncommittedChanges(workspace.cwd) : undefined,
    decideCommand: (group, agent, workspace, request, signal) =>
      approvals.decide(
        group,
        agent.id,
        {
          cwd: workspace.cwd,
          label: workspace.branch
            ? `${agent.name}'s worktree (${workspace.branch})`
            : 'the project folder',
        },
        request,
        signal,
      ),
  };
}

/**
 * Removes what Symposium keeps on disk for a group: worktrees, agent memory and the VS Code
 * workspace file. The project folder is the human's and is never touched.
 */
export function removeGroupFiles(ctx: AppContext, group: Group, agents: Agent[]): Promise<void> {
  return oneAtATime(group.id, async () => {
    await removeWorktrees(ctx.dataDir, group);
    for (const agent of agents) {
      await rm(dirname(memoryPath(ctx.dataDir, agent.id)), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    await rm(workspaceFilePath(ctx.dataDir, group), { force: true }).catch(() => undefined);
  });
}

function requirePendingDiff(message: Message) {
  const meta = message.meta;
  if (meta?.type !== 'diff') throw badRequest('That message is not a diff');
  if (meta.status !== 'pending') throw conflict(`This diff was already ${meta.status}`);
  return meta;
}

/** Merges the work shown in a diff message. The human's approval is the request itself. */
export function mergeDiff(ctx: AppContext, group: Group, message: Message): Promise<Message> {
  return oneAtATime(group.id, () => mergeDiffNow(ctx, group, message));
}

async function mergeDiffNow(ctx: AppContext, group: Group, message: Message): Promise<Message> {
  const meta = requirePendingDiff(message);
  const agent = getAgent(ctx.db, meta.agentId);
  if (!agent) throw notFound('Agent not found');
  const current = await pendingDiff(group, agent);
  if (!current || current.commit !== meta.commit) {
    throw conflict(
      `${agent.name}'s branch has changed since this diff. Review the newest diff instead.`,
    );
  }

  const mergeCommit = await mergeWork(group, agent);
  logEvent(ctx.db, {
    groupId: group.id,
    agentId: agent.id,
    kind: 'git.merge',
    detail: { branch: meta.branch, into: meta.baseBranch, commit: meta.commit, mergeCommit },
  });
  const updated = setMessageMeta(ctx, message, { ...meta, status: 'merged' });
  postNotice(
    ctx,
    group.id,
    `You merged ${agent.name}'s work into ${meta.baseBranch} (${mergeCommit.slice(0, 7)}).`,
  );
  return updated;
}

export function discardDiff(ctx: AppContext, group: Group, message: Message): Promise<Message> {
  return oneAtATime(group.id, () => discardDiffNow(ctx, group, message));
}

async function discardDiffNow(ctx: AppContext, group: Group, message: Message): Promise<Message> {
  const meta = requirePendingDiff(message);
  const agent = getAgent(ctx.db, meta.agentId);
  if (!agent) throw notFound('Agent not found');
  await discardWork(ctx.dataDir, group, agent);
  logEvent(ctx.db, {
    groupId: group.id,
    agentId: agent.id,
    kind: 'git.discard',
    detail: { branch: meta.branch, commit: meta.commit },
  });
  const updated = setMessageMeta(ctx, message, { ...meta, status: 'discarded' });
  postNotice(ctx, group.id, `You discarded ${agent.name}'s unmerged work on ${meta.branch}.`);
  return updated;
}
