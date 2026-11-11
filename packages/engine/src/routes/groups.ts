import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/database.js';
import { listGroups } from '../store/groups.js';

export function registerGroupRoutes(app: FastifyInstance, { db }: { db: Db }): void {
  app.get('/api/groups', async () => listGroups(db));
}
