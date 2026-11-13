import { createAdapter } from '@symposium/adapters';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { BUILT_IN_ROLES_DIR } from './config.js';
import type { AdapterFactory, AppContext } from './context.js';
import type { Db } from './db/database.js';
import { localhostGuard } from './localhost-guard.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerFileRoutes } from './routes/files.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerRunRoutes } from './routes/runs.js';
import { TeamRunner } from './routing/runner.js';
import { createRunnerHooks } from './workflow.js';
import { registerChatSocket } from './ws/chat-socket.js';
import { ChatHub } from './ws/chat-hub.js';

export interface ServerDeps {
  db: Db;
  dataDir: string;
  rolesDir?: string;
  /** Tests pass a factory that returns mock adapters. */
  createAdapter?: AdapterFactory;
  /** How long a group must stay idle before the scribe updates project.md. */
  scribeDelayMs?: number;
  /** The shortest time between two pushes of one agent's live diff. */
  liveChangesIntervalMs?: number;
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    symposium: { ctx: AppContext; runner: TeamRunner };
  }
}

const defaultAdapterFactory: AdapterFactory = (agent) =>
  createAdapter(agent.provider, agent.options);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Reject unknown fields instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
  });
  const ctx: AppContext = {
    db: deps.db,
    hub: new ChatHub(),
    dataDir: deps.dataDir,
    rolesDir: deps.rolesDir ?? BUILT_IN_ROLES_DIR,
    createAdapter: deps.createAdapter ?? defaultAdapterFactory,
  };

  const runner = new TeamRunner(ctx, createRunnerHooks(ctx), {
    scribeDelayMs: deps.scribeDelayMs,
    liveChangesIntervalMs: deps.liveChangesIntervalMs,
  });
  app.decorate('symposium', { ctx, runner });
  app.addHook('onClose', async () => runner.shutdown());

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Something went wrong in the engine. See its log.' });
    }
    return reply.code(status).send({ error: error.message });
  });

  app.addHook('onRequest', localhostGuard);
  await app.register(websocket);

  registerHealthRoutes(app);
  registerGroupRoutes(app, ctx, runner);
  registerAgentRoutes(app, ctx, runner);
  registerMessageRoutes(app, ctx, runner);
  registerRunRoutes(app, ctx, runner);
  registerDocumentRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerChatSocket(app, ctx);

  return app;
}
