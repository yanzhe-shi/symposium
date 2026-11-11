import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/database.js';
import { getGroup } from '../store/groups.js';
import type { ChatHub } from './chat-hub.js';

interface SocketQuery {
  groupId: string;
}

/**
 * GET /ws?groupId=… upgrades to a WebSocket that receives the group's events.
 * The socket is push-only: clients send messages with POST /api/groups/:groupId/messages.
 */
export function registerChatSocket(
  app: FastifyInstance,
  { db, hub }: { db: Db; hub: ChatHub },
): void {
  app.get<{ Querystring: SocketQuery }>(
    '/ws',
    {
      websocket: true,
      schema: {
        querystring: {
          type: 'object',
          required: ['groupId'],
          properties: { groupId: { type: 'string', minLength: 1 } },
        },
      },
      // Runs before the upgrade, so an unknown group gets a plain 404 instead of a socket.
      preHandler: async (request, reply) => {
        if (!getGroup(db, request.query.groupId)) {
          await reply.code(404).send({ error: `Group ${request.query.groupId} not found` });
        }
      },
    },
    (socket, request) => {
      hub.add(request.query.groupId, socket);
    },
  );
}
