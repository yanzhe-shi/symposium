import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { postNotice } from '../chat.js';
import { prepareRepository } from '../git/repository.js';
import { prepareProjectFolder } from '../project-folder.js';
import type { CreateGroupRequest, Group, UpdateGroupRequest } from '../protocol.js';
import { createGroup, getGroup, listGroups, updateGroup } from '../store/groups.js';

export const MAX_ROUNDS_LIMIT = 10;

/** Loads a group or throws a 404. */
export function requireGroup(ctx: AppContext, groupId: string): Group {
  const group = getGroup(ctx.db, groupId);
  if (!group) throw notFound(`Group ${groupId} not found`);
  return group;
}

export function registerGroupRoutes(app: FastifyInstance, ctx: AppContext): void {
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
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      const folderPath = await prepareProjectFolder(request.body.folderPath, ctx.dataDir);
      const { baseBranch, actions } = await prepareRepository(folderPath, name);
      const group = createGroup(ctx.db, { name, folderPath, baseBranch });
      const done = actions.length > 0 ? ` Symposium ${actions.join(', ')}.` : '';
      postNotice(
        ctx,
        group.id,
        `Project folder: ${folderPath} (branch ${baseBranch}).${done} Workers get their own branch and worktree; nothing is merged without your approval.`,
      );
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
      })!;
      ctx.hub.broadcast(group.id, { type: 'group.changed', group });
      return group;
    },
  );
}
