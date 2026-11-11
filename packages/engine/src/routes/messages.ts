import type { FastifyInstance } from 'fastify';
import { postMessage } from '../chat.js';
import type { AppContext } from '../context.js';
import { badRequest } from '../errors.js';
import type { CreateMessageRequest } from '../protocol.js';
import { listMessages, MAX_PAGE_SIZE } from '../store/messages.js';
import type { TeamRunner } from '../routing/runner.js';
import { requireGroup } from './groups.js';

export const MAX_MESSAGE_LENGTH = 20_000;

interface GroupParams {
  groupId: string;
}

interface ListQuery {
  afterId?: number;
  limit?: number;
}

export function registerMessageRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runner: TeamRunner,
): void {
  app.get<{ Params: GroupParams; Querystring: ListQuery }>(
    '/api/groups/:groupId/messages',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            afterId: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      return listMessages(ctx.db, group.id, request.query);
    },
  );

  app.post<{ Params: GroupParams; Body: CreateMessageRequest }>(
    '/api/groups/:groupId/messages',
    {
      schema: {
        body: {
          type: 'object',
          required: ['body'],
          properties: {
            body: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_LENGTH },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const group = requireGroup(ctx, request.params.groupId);
      const { body } = request.body;
      if (body.trim() === '') throw badRequest('Message body must not be blank');
      // Every message posted over HTTP comes from the human.
      const message = postMessage(ctx, { groupId: group.id, authorKind: 'human', body });
      // The team works in the background; progress arrives over the WebSocket.
      void runner.onHumanMessage(group, message);
      return reply.code(201).send(message);
    },
  );
}
