import { join } from 'node:path';
import {
  createAdapter,
  privateNetworkAvailable,
  sandboxAvailable,
  type ProviderId,
} from '@symposium/adapters';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { CommandApprovals } from './commands/approvals.js';
import { HumanTerminal } from './commands/terminal.js';
import { BUILT_IN_ROLES_DIR, DEFAULT_PORT, DEFAULT_PROJECTS_DIR } from './config.js';
import type { AdapterFactory, AppContext } from './context.js';
import type { Db } from './db/database.js';
import { localhostGuard } from './localhost-guard.js';
import { RoleStore } from './roles.js';
import { registerUi } from './static-ui.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerFileRoutes } from './routes/files.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerRoleRoutes } from './routes/roles.js';
import { registerTeamRoutes } from './routes/teams.js';
import { registerRunRoutes } from './routes/runs.js';
import { TeamRunner } from './routing/runner.js';
import { createRunnerHooks } from './workflow.js';
import { registerChatSocket } from './ws/chat-socket.js';
import { ChatHub } from './ws/chat-hub.js';

export interface ServerDeps {
  db: Db;
  dataDir: string;
  rolesDir?: string;
  /** The built chat page to serve. Left out, the engine serves the API only. */
  uiDir?: string;
  /** Where new projects go unless the human picks another folder. */
  projectsDir?: string;
  /** The command that starts VS Code. Tests pass a stand-in. */
  vscodeCommand?: string;
  /** Tests pass a factory that returns mock adapters. */
  createAdapter?: AdapterFactory;
  /** Whether agents' processes can be sandboxed here. Tests answer for themselves. */
  canSandbox?: (provider?: ProviderId) => Promise<boolean>;
  /** Whether a sandbox can have a network of its own here. Tests answer for themselves. */
  canIsolateNetwork?: () => Promise<boolean>;
  /** The port the engine listens on, which sandboxed processes must never reach. */
  port?: number;
  /** How long a group must stay idle before the scribe updates project.md. */
  scribeDelayMs?: number;
  /** The shortest time between two pushes of one agent's live diff. */
  liveChangesIntervalMs?: number;
  /** How long a command waits for the human before it is refused. */
  approvalTimeoutMs?: number;
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    symposium: { ctx: AppContext; runner: TeamRunner; approvals: CommandApprovals };
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
    roles: new RoleStore(deps.rolesDir ?? BUILT_IN_ROLES_DIR, join(deps.dataDir, 'roles')),
    projectsDir: deps.projectsDir ?? DEFAULT_PROJECTS_DIR,
    vscodeCommand: deps.vscodeCommand ?? 'code',
    createAdapter: deps.createAdapter ?? defaultAdapterFactory,
    canSandbox: deps.canSandbox ?? sandboxAvailable,
    canIsolateNetwork: deps.canIsolateNetwork ?? privateNetworkAvailable,
    enginePort: deps.port ?? DEFAULT_PORT,
  };

  const approvals = new CommandApprovals(ctx, deps.approvalTimeoutMs);
  const runner = new TeamRunner(ctx, createRunnerHooks(ctx, approvals), {
    scribeDelayMs: deps.scribeDelayMs,
    liveChangesIntervalMs: deps.liveChangesIntervalMs,
  });
  const terminal = new HumanTerminal(ctx);
  app.decorate('symposium', { ctx, runner, approvals });
  app.addHook('onClose', async () => {
    await Promise.all([terminal.shutdown(), runner.shutdown()]);
  });

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

  registerHealthRoutes(app, ctx);
  registerGroupRoutes(app, ctx, runner, terminal);
  registerAgentRoutes(app, ctx, runner);
  registerRoleRoutes(app, ctx);
  registerTeamRoutes(app, ctx, runner);
  registerMessageRoutes(app, ctx, runner);
  registerRunRoutes(app, ctx, runner, approvals, terminal);
  registerDocumentRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerFolderRoutes(app, ctx);
  registerChatSocket(app, ctx);
  // Last, so every route above wins over the page's catch-all.
  if (deps.uiDir) registerUi(app, deps.uiDir);

  return app;
}
