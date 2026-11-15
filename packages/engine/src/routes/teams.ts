import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { HireTeamRequest, SaveTeamRequest, SendAgentRequest } from '../protocol.js';
import type { TeamRunner } from '../routing/runner.js';
import { fire } from '../team.js';
import {
  hireSavedTeam,
  listSavedTeams,
  MAX_TEAM_NAME,
  removeSavedTeam,
  saveTeam,
  sendAgent,
} from '../teams.js';
import { requireGroup } from './groups.js';

/**
 * Saved teams and sending an agent to another group. Both hire agents, so both are the human's
 * to ask for: no agent can reach these routes.
 */
export function registerTeamRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runner: TeamRunner,
): void {
  app.get('/api/teams', async () => listSavedTeams(ctx));

  app.delete<{ Params: { teamId: string } }>('/api/teams/:teamId', async (request) => {
    removeSavedTeam(ctx, request.params.teamId);
    return listSavedTeams(ctx);
  });

  app.post<{ Params: { groupId: string }; Body: SaveTeamRequest }>(
    '/api/groups/:groupId/save-team',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', maxLength: MAX_TEAM_NAME * 2 },
            withMemory: { type: 'boolean' },
            replace: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const group = requireGroup(ctx, request.params.groupId);
      return reply.code(201).send(await saveTeam(ctx, group, request.body));
    },
  );

  app.post<{ Params: { groupId: string }; Body: HireTeamRequest }>(
    '/api/groups/:groupId/hire-team',
    {
      schema: {
        body: {
          type: 'object',
          required: ['teamId'],
          properties: { teamId: { type: 'string', maxLength: 60 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const group = requireGroup(ctx, request.params.groupId);
      return reply.code(201).send(await hireSavedTeam(ctx, group, request.body.teamId));
    },
  );

  app.post<{ Params: { groupId: string; agentId: string }; Body: SendAgentRequest }>(
    '/api/groups/:groupId/agents/:agentId/send',
    {
      schema: {
        body: {
          type: 'object',
          required: ['toGroupId'],
          properties: {
            toGroupId: { type: 'string', maxLength: 60 },
            withMemory: { type: 'boolean' },
            leave: { type: 'boolean' },
            name: { type: 'string', maxLength: 32 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const group = requireGroup(ctx, request.params.groupId);
      const arrived = await sendAgent(ctx, group, request.params.agentId, request.body);
      if (request.body.leave) {
        // Leaving is the Fire button's work: they stop here and take no more messages.
        const fired = fire(ctx, group, request.params.agentId);
        await runner.stopAgent(group.id, fired, false);
      }
      return reply.code(201).send(arrived);
    },
  );
}
