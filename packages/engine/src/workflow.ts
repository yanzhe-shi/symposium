import { postMessage, postNotice, setMessageMeta } from './chat.js';
import type { AppContext } from './context.js';
import { badRequest, conflict, notFound } from './errors.js';
import {
  commitWork,
  discardWork,
  ensureWorktree,
  mergeWork,
  pendingDiff,
} from './git/workspaces.js';
import type { Agent, Group, Message } from './protocol.js';
import type { RunnerHooks, Workspace } from './routing/runner.js';
import { updateProjectFile } from './scribe.js';
import { getAgent } from './store/agents.js';
import { logEvent } from './store/events.js';
import { listMessagesSince } from './store/messages.js';

/** Pending diff messages for an agent, newest last. */
function pendingDiffMessages(ctx: AppContext, group: Group, agentId: string): Message[] {
  return listMessagesSince(ctx.db, group.id, 0).filter(
    (message) =>
      message.meta?.type === 'diff' &&
      message.meta.agentId === agentId &&
      message.meta.status === 'pending',
  );
}

/** Commits a worker's changes on its branch and shows the branch's pending diff in the chat. */
async function recordWork(
  ctx: AppContext,
  group: Group,
  agent: Agent,
  workspace: Workspace,
  reply: Message,
) {
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
  postMessage(ctx, {
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

export function createRunnerHooks(ctx: AppContext): RunnerHooks {
  return {
    async prepareWorkspace(group, agent) {
      // Only workers edit, and only in their own worktree. Everyone else reads the project folder.
      if (agent.role !== 'worker' || !group.baseBranch) return { cwd: group.folderPath! };
      const worktree = await oneAtATime(group.id, () => ensureWorktree(ctx.dataDir, group, agent));
      if (worktree.warning) postNotice(ctx, group.id, worktree.warning, 'warning');
      return { cwd: worktree.path, branch: worktree.branch };
    },
    afterTurn: (group, agent, workspace, reply) =>
      oneAtATime(group.id, () => recordWork(ctx, group, agent, workspace, reply)),
    onIdle: async (group, signal) => {
      await updateProjectFile(ctx, group, signal);
    },
  };
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
