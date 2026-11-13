import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import type { FolderChoices, OpenInEditorRequest, ProjectsFolder } from '../protocol.js';
import { openInVsCode, writeWorkspaceFile } from '../vscode.js';
import { codeFolder, resolveInside } from './files.js';
import { requireGroup } from './groups.js';

/** A folder picker stops listing after this many folders. */
export const MAX_FOLDER_CHOICES = 500;

/** The folders inside `folder`, by name. Hidden ones are left out. */
async function listFolders(folder: string): Promise<{ dirs: string[]; truncated: boolean }> {
  const dirs: string[] = [];
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    try {
      // `stat` follows symlinks, so a link to a folder counts as one.
      if ((await stat(join(folder, item.name))).isDirectory()) dirs.push(item.name);
    } catch {
      // A broken link, or a folder removed while listing.
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  return { dirs: dirs.slice(0, MAX_FOLDER_CHOICES), truncated: dirs.length > MAX_FOLDER_CHOICES };
}

/**
 * Choosing a project folder, and opening things in VS Code. Both act on the human's own
 * machine at the human's request, and like every route answer only to localhost pages.
 */
export function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Where new projects go unless the human picks another folder.
  app.get('/api/fs/projects', async (): Promise<ProjectsFolder> => ({ path: ctx.projectsDir }));

  // The Browse… dialog of the new-group form: folder names only, never files or their content.
  app.get<{ Querystring: { path?: string } }>(
    '/api/fs/dirs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { path: { type: 'string', maxLength: 4096 } },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<FolderChoices> => {
      const requested = request.query.path?.trim();
      if (requested && !isAbsolute(requested)) throw badRequest('The path must be absolute');
      // Start where projects usually go, or at home when that folder does not exist yet.
      let folder = resolve(requested || ctx.projectsDir);
      if (!requested) {
        const there = await stat(folder).catch(() => undefined);
        if (!there?.isDirectory()) folder = homedir();
      }
      let listing;
      try {
        listing = await listFolders(folder);
      } catch {
        throw notFound(`${folder} is not a folder that can be read`);
      }
      const parent = dirname(folder);
      return { path: folder, parent: parent === folder ? null : parent, ...listing };
    },
  );

  // "Open in VS Code": the group's whole workspace, one folder, or one file.
  app.post<{ Params: { groupId: string }; Body: OpenInEditorRequest }>(
    '/api/groups/:groupId/open',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            where: { type: 'string', minLength: 1, maxLength: 100 },
            path: { type: 'string', maxLength: 4096 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const group = requireGroup(ctx, request.params.groupId);
      const { where, path } = request.body ?? {};
      if (!where) {
        if (path) throw badRequest('Say which folder the file is in');
        const workspace = await writeWorkspaceFile(ctx, group);
        await openInVsCode(ctx, [workspace]);
        return { opened: workspace };
      }
      const folder = codeFolder(ctx, group, where);
      // The same confinement as reading a file: nothing outside the folder is opened.
      const target = await resolveInside(folder.path, path ?? '').catch((error: unknown) => {
        if (!path) throw notFound(`${folder.label} does not exist yet`);
        throw error;
      });
      await openInVsCode(ctx, path ? ['-g', target] : [target]);
      return { opened: target };
    },
  );
}
