import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { NO_CHANGES, uncommittedChanges, worktreePath } from '../git/workspaces.js';
import type {
  Agent,
  AgentEvent,
  AgentProgress,
  FileContent,
  FileEntry,
  FolderListing,
  Group,
  WorktreeChanges,
} from '../protocol.js';
import { AGENT_TOOL_EVENT } from '../routing/runner.js';
import { getAgent } from '../store/agents.js';
import { listRecentEvents } from '../store/events.js';
import { requireGroup } from './groups.js';

/** Files larger than this are not sent to the Code tab. */
export const MAX_FILE_BYTES = 512 * 1024;
/** A folder listing stops after this many entries. */
export const MAX_FOLDER_ENTRIES = 1000;
const BINARY_CHECK_BYTES = 8000;
const MAX_ACTIVITY = 500;

/** Whether `path` is `root` or lies inside it. Both must be absolute. */
function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return !inside.startsWith('..') && !isAbsolute(inside);
}

/** Git's own data is never shown: it can hold remote URLs and other people's history. */
function touchesGitData(root: string, path: string): boolean {
  return relative(root, path).split(sep).includes('.git');
}

/**
 * Turns a path the browser asked for into a real path, and refuses anything that is not inside
 * `root`: `..`, absolute paths, and symlinks that lead out of the folder.
 */
export async function resolveInside(root: string, requested: string): Promise<string> {
  if (requested.includes('\0') || isAbsolute(requested)) {
    throw badRequest('The path must be relative to the folder');
  }
  const target = resolve(root, requested);
  if (!isInside(root, target)) throw badRequest('That path is outside the folder');
  if (touchesGitData(root, target)) throw notFound('Not found');

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(target);
  } catch {
    throw notFound('Not found');
  }
  // The path as written stays inside, but a symlink on the way may not.
  if (!isInside(realRoot, realTarget)) throw badRequest('That path leads outside the folder');
  if (touchesGitData(realRoot, realTarget)) throw notFound('Not found');
  return realTarget;
}

/** Lists a folder: folders first, then files, by name. `.git` is left out. */
export async function listFolder(folder: string): Promise<Omit<FolderListing, 'path'>> {
  const entries: FileEntry[] = [];
  for (const item of await readdir(folder, { withFileTypes: true })) {
    if (item.name === '.git') continue;
    try {
      // `stat` follows symlinks, so a link shows as what it points to. One that leads out of the
      // folder is listed but cannot be opened.
      const info = await stat(join(folder, item.name));
      if (info.isDirectory()) entries.push({ name: item.name, type: 'dir', size: 0 });
      else if (info.isFile()) entries.push({ name: item.name, type: 'file', size: info.size });
    } catch {
      // A broken link, or a file removed while listing.
    }
  }
  entries.sort(
    (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name),
  );
  return {
    entries: entries.slice(0, MAX_FOLDER_ENTRIES),
    truncated: entries.length > MAX_FOLDER_ENTRIES,
  };
}

/** Reads a text file. Large and binary files are reported, not sent. */
export async function readTextFile(file: string): Promise<Omit<FileContent, 'path'>> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw badRequest('That is not a file');
    if (info.size > MAX_FILE_BYTES) {
      return { size: info.size, content: null, skipped: 'too-large' };
    }
    const bytes = await handle.readFile();
    if (bytes.subarray(0, BINARY_CHECK_BYTES).includes(0)) {
      return { size: info.size, content: null, skipped: 'binary' };
    }
    return { size: info.size, content: bytes.toString('utf8') };
  } finally {
    await handle.close();
  }
}

const whereSchema = {
  type: 'object',
  required: ['where'],
  properties: {
    where: { type: 'string', minLength: 1, maxLength: 100 },
    path: { type: 'string', maxLength: 4096 },
  },
  additionalProperties: false,
} as const;

interface WhereQuery {
  where: string;
  path?: string;
}

/**
 * Read-only views for the Code tab: the files of the project folder or of an agent's worktree,
 * an agent's uncommitted changes, and what agents did recently. Nothing here can write.
 */
export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  function requireAgent(group: Group, agentId: string): Agent {
    const agent = getAgent(ctx.db, agentId);
    if (!agent || agent.groupId !== group.id) throw notFound('Agent not found');
    return agent;
  }

  /** The folder a request may look into: the project folder, or one agent's worktree. */
  function rootOf(group: Group, where: string): string {
    if (where === 'project') {
      if (!group.folderPath) throw badRequest('This group has no project folder');
      return group.folderPath;
    }
    return worktreePath(ctx.dataDir, group, requireAgent(group, where));
  }

  /** The requested path with `/` separators, as the UI addresses it. */
  function shownPath(path: string | undefined): string {
    return (path ?? '')
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/');
  }

  app.get<{ Params: { groupId: string }; Querystring: WhereQuery }>(
    '/api/groups/:groupId/files',
    { schema: { querystring: whereSchema } },
    async (request): Promise<FolderListing> => {
      const group = requireGroup(ctx, request.params.groupId);
      const root = rootOf(group, request.query.where);
      const folder = await resolveInside(root, request.query.path ?? '');
      if (!(await stat(folder)).isDirectory()) throw badRequest('That is not a folder');
      return { path: shownPath(request.query.path), ...(await listFolder(folder)) };
    },
  );

  app.get<{ Params: { groupId: string }; Querystring: WhereQuery }>(
    '/api/groups/:groupId/file',
    { schema: { querystring: { ...whereSchema, required: ['where', 'path'] } } },
    async (request): Promise<FileContent> => {
      const group = requireGroup(ctx, request.params.groupId);
      const root = rootOf(group, request.query.where);
      const file = await resolveInside(root, request.query.path ?? '');
      return { path: shownPath(request.query.path), ...(await readTextFile(file)) };
    },
  );

  // An agent's uncommitted work right now, for a page that just opened.
  app.get<{ Params: { groupId: string }; Querystring: { where: string } }>(
    '/api/groups/:groupId/changes',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['where'],
          properties: { where: whereSchema.properties.where },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<WorktreeChanges> => {
      const group = requireGroup(ctx, request.params.groupId);
      const agent = requireAgent(group, request.query.where);
      if (!group.baseBranch) return NO_CHANGES;
      return uncommittedChanges(worktreePath(ctx.dataDir, group, agent));
    },
  );

  // The team's recent tool calls from the audit log, oldest first, so the activity timeline
  // survives a reload.
  app.get<{ Params: { groupId: string }; Querystring: { limit?: number } }>(
    '/api/groups/:groupId/activity',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_ACTIVITY } },
          additionalProperties: false,
        },
      },
    },
    async (request): Promise<AgentProgress[]> => {
      const group = requireGroup(ctx, request.params.groupId);
      const limit = request.query.limit ?? 200;
      return listRecentEvents(ctx.db, group.id, AGENT_TOOL_EVENT, limit)
        .filter((record) => record.agentId !== null)
        .map((record) => ({
          agentId: record.agentId!,
          at: record.createdAt,
          event: record.detail as unknown as AgentEvent,
        }));
    },
  );
}
