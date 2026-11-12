import { PROVIDERS } from '@symposium/adapters';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { HireRequest } from '../protocol.js';
import { ROLES } from '../roles.js';
import type { TeamRunner } from '../routing/runner.js';
import { listAgents } from '../store/agents.js';
import { fire, hire } from '../team.js';
import { requireGroup } from './groups.js';

export const hireBodySchema = {
  type: 'object',
  required: ['name', 'provider', 'model', 'role'],
  properties: {
    name: { type: 'string', maxLength: 32 },
    provider: { type: 'string' },
    model: { type: 'string', maxLength: 100 },
    role: { type: 'string' },
    instructions: { type: 'string', maxLength: 8000 },
    options: {
      type: 'object',
      properties: {
        command: { type: 'string', maxLength: 500 },
        baseUrl: { type: 'string', maxLength: 500 },
        apiKeyEnv: { type: 'string', maxLength: 100 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runner: TeamRunner,
): void {
  app.get('/api/providers', async () => PROVIDERS);
  app.get('/api/roles', async () => ROLES);

  app.get<{ Params: { groupId: string }; Querystring: { includeFired?: boolean } }>(
    '/api/groups/:groupId/agents',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { includeFired: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      return listAgents(ctx.db, group.id, { includeFired: request.query.includeFired });
    },
  );

  app.post<{ Params: { groupId: string }; Body: HireRequest }>(
    '/api/groups/:groupId/agents',
    { schema: { body: hireBodySchema } },
    async (request, reply) => {
      const group = requireGroup(ctx, request.params.groupId);
      return reply.code(201).send(hire(ctx, group, request.body));
    },
  );

  app.delete<{ Params: { groupId: string; agentId: string } }>(
    '/api/groups/:groupId/agents/:agentId',
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      const fired = fire(ctx, group, request.params.agentId);
      // Someone who left the team stops working and takes no more messages.
      await runner.stopAgent(group.id, fired, false);
      return fired;
    },
  );
}
