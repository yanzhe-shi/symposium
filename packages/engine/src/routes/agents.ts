import { isProviderId, listModels, PROVIDERS } from '@symposium/adapters';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import type { HireRequest, ModelList, UpdateAgentRequest } from '../protocol.js';
import { ROLES } from '../roles.js';
import type { TeamRunner } from '../routing/runner.js';
import { listAgents } from '../store/agents.js';
import { editAgent, fire, hire, validateOptions } from '../team.js';
import { requireGroup } from './groups.js';

const optionsSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', maxLength: 500 },
    baseUrl: { type: 'string', maxLength: 500 },
    apiKeyEnv: { type: 'string', maxLength: 100 },
  },
  additionalProperties: false,
} as const;

// The values are checked by validateSettings, which explains what is wrong.
const settingsSchema = {
  type: 'object',
  properties: {
    files: { type: 'string' },
    commands: { type: 'string' },
    allowlist: { type: 'array', items: { type: 'string' } },
    effort: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const agentProperties = {
  provider: { type: 'string' },
  model: { type: 'string', maxLength: 100 },
  role: { type: 'string' },
  instructions: { type: 'string', maxLength: 8000 },
  options: optionsSchema,
  settings: settingsSchema,
} as const;

export const hireBodySchema = {
  type: 'object',
  required: ['name', 'provider', 'model', 'role'],
  properties: { name: { type: 'string', maxLength: 32 }, ...agentProperties },
  additionalProperties: false,
} as const;

// No name: an agent keeps its name, which its branch and its @mentions depend on.
const editBodySchema = {
  type: 'object',
  properties: agentProperties,
  additionalProperties: false,
} as const;

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runner: TeamRunner,
): void {
  app.get('/api/providers', async () => PROVIDERS);
  app.get('/api/roles', async () => ROLES);

  // The models a provider offers right now, for the model picker. The field stays free text,
  // so a failed lookup only means fewer suggestions.
  app.get<{
    Params: { providerId: string };
    Querystring: { command?: string; baseUrl?: string; apiKeyEnv?: string };
  }>(
    '/api/providers/:providerId/models',
    { schema: { querystring: optionsSchema } },
    async (request): Promise<ModelList> => {
      const provider = PROVIDERS.find((info) => info.id === request.params.providerId);
      if (!provider || !isProviderId(provider.id)) throw notFound('Unknown provider');
      const options = validateOptions(request.query);
      try {
        return { models: await listModels(provider.id, options) };
      } catch (error) {
        return {
          models: provider.modelSuggestions.map((id) => ({ id })),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

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

  // Change an agent without firing it. Applies from its next turn.
  app.patch<{ Params: { groupId: string; agentId: string }; Body: UpdateAgentRequest }>(
    '/api/groups/:groupId/agents/:agentId',
    { schema: { body: editBodySchema } },
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      return editAgent(ctx, group, request.params.agentId, request.body);
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
