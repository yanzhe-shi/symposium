import { MAX_CHECK_COMMAND_LENGTH } from '../checks.js';
import type { FastifyInstance } from 'fastify';
import type { HumanTerminal } from '../commands/terminal.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { postNotice } from '../chat.js';
import { prepareRepository } from '../git/repository.js';
import { prepareProjectFolder } from '../project-folder.js';
import type { CreateGroupRequest, Group, UpdateGroupRequest } from '../protocol.js';
import type { TeamRunner } from '../routing/runner.js';
import { listAgents } from '../store/agents.js';
import { createGroup, deleteGroup, getGroup, listGroups, updateGroup } from '../store/groups.js';
import { STARTER_PROVIDERS, starterTeam } from '../system.js';
import { hire } from '../team.js';
import { hireSavedTeam, listSavedTeams } from '../teams.js';
import { removeGroupFiles } from '../workflow.js';

export const MAX_ROUNDS_LIMIT = 10;
export const MAX_PARALLEL_LIMIT = 8;

/** Loads a group or throws a 404. */
export function requireGroup(ctx: AppContext, groupId: string): Group {
  const group = getGroup(ctx.db, groupId);
  if (!group) throw notFound(`Group ${groupId} not found`);
  return group;
}

export function registerGroupRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  runner: TeamRunner,
  terminal: HumanTerminal,
): void {
  app.get('/api/groups', async () => listGroups(ctx.db));

  app.get<{ Params: { groupId: string } }>('/api/groups/:groupId', async (request) =>
    requireGroup(ctx, request.params.groupId),
  );

  app.post<{ Body: CreateGroupRequest }>(
    '/api/groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'folderPath'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            folderPath: { type: 'string', minLength: 1, maxLength: 1000 },
            starterTeam: { type: 'string', enum: [...STARTER_PROVIDERS] },
            team: { type: 'string', maxLength: 60 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      const { starterTeam: starter, team: savedTeam } = request.body;
      if (starter && savedTeam) throw badRequest('Choose a starter team or a saved team, not both');
      // Checked before anything is created, so a wrong team leaves no half-made group behind.
      if (savedTeam && !listSavedTeams(ctx).some((team) => team.id === savedTeam)) {
        throw notFound('Saved team not found');
      }
      const folderPath = await prepareProjectFolder(request.body.folderPath, ctx.dataDir);
      const { baseBranch, actions } = await prepareRepository(folderPath, name);
      const group = createGroup(ctx.db, { name, folderPath, baseBranch });
      const done = actions.length > 0 ? ` Symposium ${actions.join(', ')}.` : '';
      postNotice(
        ctx,
        group.id,
        `Project folder: ${folderPath} (branch ${baseBranch}).${done} Workers get their own branch and worktree; nothing is merged without your approval.`,
      );
      // The human asked for a team with the group, which is their approval of these hires.
      if (starter) {
        for (const member of starterTeam(starter)) hire(ctx, group, member);
      }
      if (savedTeam) await hireSavedTeam(ctx, group, savedTeam);
      return reply.code(201).send(group);
    },
  );

  app.patch<{ Params: { groupId: string }; Body: UpdateGroupRequest }>(
    '/api/groups/:groupId',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            maxRounds: { type: 'integer', minimum: 1, maximum: MAX_ROUNDS_LIMIT },
            maxParallel: { type: 'integer', minimum: 1, maximum: MAX_PARALLEL_LIMIT },
            leadAsksFirst: { type: 'boolean' },
            checkCommand: { type: 'string', maxLength: MAX_CHECK_COMMAND_LENGTH },
            autoReview: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      requireGroup(ctx, request.params.groupId);
      const group = updateGroup(ctx.db, request.params.groupId, {
        name: request.body.name?.trim(),
        maxRounds: request.body.maxRounds,
        maxParallel: request.body.maxParallel,
        leadAsksFirst: request.body.leadAsksFirst,
        checkCommand: request.body.checkCommand?.trim(),
        autoReview: request.body.autoReview,
      })!;
      ctx.hub.broadcast(group.id, { type: 'group.changed', group });
      // A higher cap may let waiting agents start.
      runner.pump(group.id);
      return group;
    },
  );

  // Deletes the group for good: its chat, team, audit log, agent memory and worktrees. Only the
  // human can ask for this. The project folder and its git branches are never touched.
  app.delete<{ Params: { groupId: string } }>('/api/groups/:groupId', async (request) => {
    const group = requireGroup(ctx, request.params.groupId);
    await Promise.all([runner.dropGroup(group.id), terminal.stopGroup(group.id)]);
    const agents = listAgents(ctx.db, group.id, { includeFired: true });
    await removeGroupFiles(ctx, group, agents);
    deleteGroup(ctx.db, group.id);
    ctx.hub.broadcast(group.id, { type: 'group.deleted' });
    return { deleted: true };
  });
}
