import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { readMemory, writeMemory, MAX_MEMORY_FILE } from '../memory.js';
import { readProjectFile, writeProjectFile } from '../project-file.js';
import { MAX_PROJECT_FILE } from '../scribe.js';
import { getAgent } from '../store/agents.js';
import { logEvent } from '../store/events.js';
import { requireGroup } from './groups.js';

const contentSchema = (maxLength: number) => ({
  body: {
    type: 'object',
    required: ['content'],
    properties: { content: { type: 'string', maxLength } },
    additionalProperties: false,
  },
});

/** project.md and agent memory: readable by the human, and editable as a manual override. */
export function registerDocumentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { groupId: string } }>('/api/groups/:groupId/project', async (request) => {
    const group = requireGroup(ctx, request.params.groupId);
    return { content: await readProjectFile(group.folderPath) };
  });

  app.put<{ Params: { groupId: string }; Body: { content: string } }>(
    '/api/groups/:groupId/project',
    { schema: contentSchema(MAX_PROJECT_FILE) },
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      if (!group.folderPath) throw badRequest('This group has no project folder');
      await writeProjectFile(group.folderPath, request.body.content);
      logEvent(ctx.db, { groupId: group.id, kind: 'project.edited_by_human' });
      ctx.hub.broadcast(group.id, { type: 'project.updated' });
      return { content: await readProjectFile(group.folderPath) };
    },
  );

  app.get<{ Params: { groupId: string; agentId: string } }>(
    '/api/groups/:groupId/agents/:agentId/memory',
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      const agent = getAgent(ctx.db, request.params.agentId);
      if (!agent || agent.groupId !== group.id) throw notFound('Agent not found');
      return { content: await readMemory(ctx.dataDir, agent.id) };
    },
  );

  app.put<{ Params: { groupId: string; agentId: string }; Body: { content: string } }>(
    '/api/groups/:groupId/agents/:agentId/memory',
    { schema: contentSchema(MAX_MEMORY_FILE) },
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      const agent = getAgent(ctx.db, request.params.agentId);
      if (!agent || agent.groupId !== group.id) throw notFound('Agent not found');
      await writeMemory(ctx.dataDir, agent.id, request.body.content);
      logEvent(ctx.db, { groupId: group.id, agentId: agent.id, kind: 'memory.edited_by_human' });
      return { content: request.body.content };
    },
  );
}
