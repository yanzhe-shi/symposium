import type { FastifyInstance } from 'fastify';
import { postNotice, setMessageMeta } from '../chat.js';
import type { CommandApprovals, CommandChoice } from '../commands/approvals.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { MAX_COMMAND_LENGTH, type HumanTerminal } from '../commands/terminal.js';
import type { Message, RunCommandRequest, TerminalRun } from '../protocol.js';
import type { TeamRunner } from '../routing/runner.js';
import { getAgent } from '../store/agents.js';
import { getMessage } from '../store/messages.js';
import { hire } from '../team.js';
import { discardDiff, mergeDiff } from '../workflow.js';
import { codeFolder } from './files.js';
import { requireGroup } from './groups.js';

export function requireMessage(ctx: AppContext, groupId: string, messageId: number): Message {
  const message = getMessage(ctx.db, messageId);
  if (!message || message.groupId !== groupId) throw notFound('Message not found');
  return message;
}

const COMMAND_CHOICES: Record<string, CommandChoice> = {
  'allow-command': 'allow',
  'always-allow-command': 'always',
  'deny-command': 'deny',
};

export function registerRunRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runner: TeamRunner,
  approvals: CommandApprovals,
  terminal: HumanTerminal,
): void {
  // The human's own terminal: a command they type in the Code tab, run in the project folder
  // or in an agent's worktree. Its output arrives over the WebSocket.
  app.post<{ Params: { groupId: string }; Body: RunCommandRequest }>(
    '/api/groups/:groupId/terminal',
    {
      schema: {
        body: {
          type: 'object',
          required: ['where', 'command'],
          properties: {
            where: { type: 'string', minLength: 1, maxLength: 100 },
            command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_LENGTH },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply): Promise<TerminalRun> => {
      const group = requireGroup(ctx, request.params.groupId);
      const { where, command } = request.body;
      const run = terminal.start(group, where, codeFolder(ctx, group, where), command);
      return reply.code(201).send(run);
    },
  );

  app.post<{ Params: { groupId: string; runId: string } }>(
    '/api/groups/:groupId/terminal/:runId/stop',
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      return { stopped: terminal.stop(group.id, request.params.runId) };
    },
  );

  // Who is working and which messages are waiting in whose inbox.
  app.get<{ Params: { groupId: string } }>('/api/groups/:groupId/run', async (request) => {
    const group = requireGroup(ctx, request.params.groupId);
    return runner.status(group.id);
  });

  // Stop all: cancels every turn and empties every inbox.
  app.post<{ Params: { groupId: string } }>('/api/groups/:groupId/stop', async (request) => {
    const group = requireGroup(ctx, request.params.groupId);
    return { stopped: await runner.stopGroup(group.id) };
  });

  // Stop one agent: cancels its turn and empties its inbox. Everyone else carries on.
  app.post<{ Params: { groupId: string; agentId: string } }>(
    '/api/groups/:groupId/agents/:agentId/stop',
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      const agent = getAgent(ctx.db, request.params.agentId);
      if (!agent || agent.groupId !== group.id) throw notFound('Agent not found');
      return { stopped: await runner.stopAgent(group.id, agent) };
    },
  );

  // Decisions only the human can make: approving the lead's plan and the hires it proposed,
  // merging or discarding a worker's changes, and letting an agent run a terminal command.
  app.post<{ Params: { groupId: string; messageId: number; decision: string } }>(
    '/api/groups/:groupId/messages/:messageId/:decision',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            groupId: { type: 'string' },
            messageId: { type: 'integer' },
            decision: {
              type: 'string',
              enum: [
                'approve-hire',
                'reject-hire',
                'approve-plan',
                'decline-plan',
                'merge',
                'discard',
                ...Object.keys(COMMAND_CHOICES),
              ],
            },
          },
        },
      },
    },
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      const message = requireMessage(ctx, group.id, request.params.messageId);
      if (request.params.decision === 'merge') return mergeDiff(ctx, group, message);
      if (request.params.decision === 'discard') return discardDiff(ctx, group, message);
      if (request.params.decision === 'approve-plan')
        return runner.decidePlan(group, message, true);
      if (request.params.decision === 'decline-plan')
        return runner.decidePlan(group, message, false);
      const commandChoice = COMMAND_CHOICES[request.params.decision];
      if (commandChoice) return approvals.resolve(group, message, commandChoice);

      const meta = message.meta;
      if (meta?.type !== 'hire-proposal') throw badRequest('That message is not a hire proposal');
      if (meta.status !== 'pending') throw conflict(`This proposal was already ${meta.status}`);

      if (request.params.decision === 'approve-hire') {
        // A role the lead wrote for this hire is added with it, unless an earlier approval
        // or the human already made a role of that name.
        if (meta.newRole && !ctx.roles.find(meta.newRole.title)) ctx.roles.create(meta.newRole);
        hire(ctx, group, meta.hire);
        return setMessageMeta(ctx, message, { ...meta, status: 'approved' });
      }
      postNotice(ctx, group.id, `You declined hiring ${meta.hire.name}.`);
      return setMessageMeta(ctx, message, { ...meta, status: 'rejected' });
    },
  );
}
