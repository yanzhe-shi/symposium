import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requireGroup } from '../routes/groups.js';

interface SocketQuery {
  groupId: string;
}

/**
 * GET /ws?groupId=… upgrades to a WebSocket that receives the group's events.
 * The socket is push-only: clients act through the HTTP API.
 */
export function registerChatSocket(app: FastifyInstance, ctx: AppContext): void {
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
      preHandler: async (request) => {
        requireGroup(ctx, request.query.groupId);
      },
    },
    (socket, request) => {
      ctx.hub.add(request.query.groupId, socket);
    },
  );
}
