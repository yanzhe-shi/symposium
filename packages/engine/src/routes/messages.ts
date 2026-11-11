import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/database.js';
import type { CreateMessageRequest } from '../protocol.js';
import { getGroup } from '../store/groups.js';
import { insertMessage, listMessages, MAX_PAGE_SIZE } from '../store/messages.js';
import type { ChatHub } from '../ws/chat-hub.js';

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
  { db, hub }: { db: Db; hub: ChatHub },
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
    async (request, reply) => {
      const { groupId } = request.params;
      if (!getGroup(db, groupId)) {
        return reply.code(404).send({ error: `Group ${groupId} not found` });
      }
      return listMessages(db, groupId, request.query);
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
      const { groupId } = request.params;
      if (!getGroup(db, groupId)) {
        return reply.code(404).send({ error: `Group ${groupId} not found` });
      }
      const { body } = request.body;
      if (body.trim() === '') {
        return reply.code(400).send({ error: 'Message body must not be blank' });
      }
      // In milestone 1 every message posted over HTTP comes from the human.
      const message = insertMessage(db, { groupId, authorKind: 'human', body });
      hub.broadcast(groupId, { type: 'message.created', message });
      return reply.code(201).send(message);
    },
  );
}
