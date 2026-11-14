import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../errors.js';
import type { RoleDraft } from '../protocol.js';
import { MAX_ROLE_SUMMARY, MAX_ROLE_TEXT, MAX_ROLE_TITLE } from '../roles.js';

const draftProperties = {
  title: { type: 'string', maxLength: MAX_ROLE_TITLE * 2 },
  kind: { type: 'string', maxLength: 20 },
  summary: { type: 'string', maxLength: MAX_ROLE_SUMMARY * 2 },
  text: { type: 'string', maxLength: MAX_ROLE_TEXT * 2 },
} as const;

/** Active agents hired into a role, as "Ada (Shop)". */
function holders(ctx: AppContext, roleId: string): string[] {
  const rows = ctx.db
    .prepare(
      `SELECT agents.name AS agent, groups.name AS grp FROM agents
       JOIN groups ON groups.id = agents.group_id
       WHERE agents.role_id = ? AND agents.fired_at IS NULL ORDER BY agents.created_at`,
    )
    .all(roleId) as { agent: string; grp: string }[];
  return rows.map((row) => `${row.agent} (${row.grp})`);
}

/**
 * Roles are the human's to write. They apply to every group, and a change reaches the agents
 * in that role at their next turn.
 */
export function registerRoleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/roles', async () => ctx.roles.list());

  app.post<{ Body: Partial<RoleDraft> }>(
    '/api/roles',
    {
      schema: {
        body: { type: 'object', properties: draftProperties, additionalProperties: false },
      },
    },
    async (request, reply) => reply.code(201).send(ctx.roles.create(request.body)),
  );

  app.put<{ Params: { roleId: string }; Body: Partial<RoleDraft> }>(
    '/api/roles/:roleId',
    {
      schema: {
        body: { type: 'object', properties: draftProperties, additionalProperties: false },
      },
    },
    async (request) => ctx.roles.update(request.params.roleId, request.body),
  );

  // Deletes a custom role. For a built-in role it brings back the job description it came with.
  app.delete<{ Params: { roleId: string } }>('/api/roles/:roleId', async (request) => {
    const role = ctx.roles.get(request.params.roleId);
    if (!role) throw notFound(`Role "${request.params.roleId}" not found`);
    if (!role.builtIn) {
      const inUse = holders(ctx, role.id);
      if (inUse.length > 0) {
        throw conflict(
          `${inUse.join(', ')} ${inUse.length === 1 ? 'has' : 'have'} this role. Give them another role or fire them first.`,
        );
      }
    }
    ctx.roles.remove(role.id);
    return ctx.roles.list();
  });
}
