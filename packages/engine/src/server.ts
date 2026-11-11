import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';
import type { Db } from './db/database.js';
import { localhostGuard } from './localhost-guard.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerChatSocket } from './ws/chat-socket.js';
import { ChatHub } from './ws/chat-hub.js';

export interface ServerDeps {
  db: Db;
  logger?: FastifyServerOptions['logger'];
}

export async function buildServer({ db, logger = false }: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    // Reject unknown fields instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const hub = new ChatHub();

  app.addHook('onRequest', localhostGuard);
  await app.register(websocket);

  registerHealthRoutes(app);
  registerGroupRoutes(app, { db });
  registerMessageRoutes(app, { db, hub });
  registerChatSocket(app, { db, hub });

  return app;
}
