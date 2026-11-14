import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { systemInfo } from '../system.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ status: 'ok' }));

  // What is installed here, for the checks a new user sees before the first project.
  app.get('/api/system', async () => systemInfo(ctx));
}
