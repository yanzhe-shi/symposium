import type { FastifyInstance } from 'fastify';
import { postNotice, setMessageMeta } from '../chat.js';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { Message } from '../protocol.js';
import type { TeamRunner } from '../routing/runner.js';
import { getAgent } from '../store/agents.js';
import { getMessage } from '../store/messages.js';
import { hire } from '../team.js';
import { discardDiff, mergeDiff } from '../workflow.js';
import { requireGroup } from './groups.js';

export function requireMessage(ctx: AppContext, groupId: string, messageId: number): Message {
  const message = getMessage(ctx.db, messageId);
  if (!message || message.groupId !== groupId) throw notFound('Message not found');
  return message;
}

export function registerRunRoutes(app: FastifyInstance, ctx: AppContext, runner: TeamRunner): void {
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

  // Decisions only the human can make: approving hires the lead proposed, merging or
  // discarding a worker's changes.
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
              enum: ['approve-hire', 'reject-hire', 'merge', 'discard'],
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

      const meta = message.meta;
      if (meta?.type !== 'hire-proposal') throw badRequest('That message is not a hire proposal');
      if (meta.status !== 'pending') throw conflict(`This proposal was already ${meta.status}`);

      if (request.params.decision === 'approve-hire') {
        hire(ctx, group, meta.hire);
        return setMessageMeta(ctx, message, { ...meta, status: 'approved' });
      }
      postNotice(ctx, group.id, `You declined hiring ${meta.hire.name}.`);
      return setMessageMeta(ctx, message, { ...meta, status: 'rejected' });
    },
  );
}
