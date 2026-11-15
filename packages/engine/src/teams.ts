import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { postNotice } from './chat.js';
import type { AppContext } from './context.js';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { MAX_MEMORY_FILE, readMemory, writeMemory } from './memory.js';
import type {
  Agent,
  Group,
  HireRequest,
  HireTeamResult,
  SavedTeam,
  SaveTeamRequest,
  SendAgentRequest,
} from './protocol.js';
import { settingsOverrides } from './settings.js';
import { getAgent, listAgents } from './store/agents.js';
import { logEvent } from './store/events.js';
import { getGroup } from './store/groups.js';
import { hire } from './team.js';

export const MAX_TEAM_NAME = 60;
export const MAX_TEAM_MEMBERS = 30;
const TEAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** A member as the file keeps it: how to hire them, and what they remember if that was saved. */
type MemberFile = HireRequest & { memory?: string };

/** What a team file holds. No ids of groups or agents: a saved team belongs to no group. */
interface TeamFile {
  name: string;
  savedAt: number;
  members: MemberFile[];
}

function teamsDir(ctx: AppContext): string {
  return join(ctx.dataDir, 'teams');
}

function fileOf(ctx: AppContext, id: string): string {
  return join(teamsDir(ctx), `${id}.json`);
}

/** The file name a team is kept under, made from its name: "Shop crew" → "shop-crew". */
export function teamIdFor(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Reads a team file. A file that is missing or edited into something unreadable is no team. */
function readTeamFile(ctx: AppContext, id: string): TeamFile | undefined {
  if (!TEAM_ID_PATTERN.test(id)) return undefined;
  try {
    const file = JSON.parse(readFileSync(fileOf(ctx, id), 'utf8')) as Partial<TeamFile>;
    if (typeof file.name !== 'string' || !Array.isArray(file.members)) return undefined;
    const members = file.members.filter(
      (member): member is MemberFile =>
        typeof member === 'object' && member !== null && typeof member.name === 'string',
    );
    return {
      name: file.name,
      savedAt: typeof file.savedAt === 'number' ? file.savedAt : 0,
      members: members.slice(0, MAX_TEAM_MEMBERS),
    };
  } catch {
    return undefined;
  }
}

function describe(id: string, file: TeamFile): SavedTeam {
  return {
    id,
    name: file.name,
    savedAt: file.savedAt,
    members: file.members.map((member) => ({
      name: member.name,
      provider: member.provider,
      model: member.model,
      role: member.role,
      roleId: member.roleId ?? member.role,
      hasMemory: typeof member.memory === 'string' && member.memory.trim() !== '',
    })),
  };
}

/** The saved teams, by name. */
export function listSavedTeams(ctx: AppContext): SavedTeam[] {
  let names: string[];
  try {
    names = readdirSync(teamsDir(ctx));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .flatMap((id) => {
      const file = readTeamFile(ctx, id);
      return file ? [describe(id, file)] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Saves the group's current team under a name, to be hired again in another group. */
export async function saveTeam(
  ctx: AppContext,
  group: Group,
  request: SaveTeamRequest,
): Promise<SavedTeam> {
  const name = request.name?.replace(/\s+/g, ' ').trim() ?? '';
  const id = teamIdFor(name);
  if (name.length > MAX_TEAM_NAME || !TEAM_ID_PATTERN.test(id)) {
    throw badRequest(
      `A saved team needs a name of 1 to ${MAX_TEAM_NAME} characters with a letter or a digit in it`,
    );
  }
  const team = listAgents(ctx.db, group.id);
  if (team.length === 0) throw badRequest('Nobody is on the team yet, so there is nothing to save');
  const existing = readTeamFile(ctx, id);
  if (existing && !request.replace) {
    throw conflict(`There is already a saved team called "${existing.name}"`);
  }

  const members: MemberFile[] = [];
  for (const agent of team) {
    const memory = request.withMemory ? (await readMemory(ctx.dataDir, agent.id)).trim() : '';
    members.push({ ...hireRequestOf(ctx, agent), ...(memory ? { memory } : {}) });
  }
  const file: TeamFile = { name, savedAt: Date.now(), members };
  mkdirSync(teamsDir(ctx), { recursive: true });
  writeFileSync(fileOf(ctx, id), `${JSON.stringify(file, null, 2)}\n`);

  const saved = describe(id, file);
  const withMemory = saved.members.some((member) => member.hasMemory);
  logEvent(ctx.db, {
    groupId: group.id,
    kind: 'team.saved',
    detail: { teamId: id, name, members: team.map((agent) => agent.name), withMemory },
  });
  postNotice(
    ctx,
    group.id,
    `You saved this team as "${name}" (${countAgents(team.length)}${withMemory ? ', with what they remember' : ''}). You can hire it into another group.`,
  );
  return saved;
}

export function removeSavedTeam(ctx: AppContext, id: string): void {
  if (!readTeamFile(ctx, id)) throw notFound('Saved team not found');
  rmSync(fileOf(ctx, id), { force: true });
}

/**
 * Hires a saved team into a group. Only the human asks for this, which is their approval of
 * the hires. A member who cannot be hired (the name or the seat is taken) is left out and named.
 */
export async function hireSavedTeam(
  ctx: AppContext,
  group: Group,
  teamId: string,
): Promise<HireTeamResult> {
  const file = readTeamFile(ctx, teamId);
  if (!file) throw notFound('Saved team not found');

  const hired: Agent[] = [];
  const skipped: string[] = [];
  let withMemory = false;
  for (const { memory, ...member } of file.members) {
    try {
      const agent = hire(ctx, group, {
        ...member,
        // A custom role that was deleted since: the member falls back to the role's kind.
        roleId: member.roleId && ctx.roles.get(member.roleId) ? member.roleId : undefined,
      });
      hired.push(agent);
      if (typeof memory === 'string' && memory.trim() !== '') {
        await bringMemory(ctx, group, agent, memory, `the saved team "${file.name}"`);
        withMemory = true;
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      skipped.push(`${member.name}: ${error.message}`);
    }
  }

  logEvent(ctx.db, {
    groupId: group.id,
    kind: 'team.hired',
    detail: { teamId, name: file.name, hired: hired.map((agent) => agent.name), skipped },
  });
  if (hired.length > 0 && withMemory) {
    postNotice(ctx, group.id, `The team "${file.name}" brought along what they remember.`);
  }
  if (skipped.length > 0) {
    postNotice(
      ctx,
      group.id,
      `Not hired from the saved team "${file.name}": ${skipped.join('; ')}`,
      'warning',
    );
  }
  return { hired, skipped };
}

/**
 * Hires a copy of an agent into another group, with its memory unless told otherwise. The agent
 * itself never changes group: its messages, branch and audit log here stay true. Only the human
 * asks for this. The caller fires the agent here when `leave` is set.
 */
export async function sendAgent(
  ctx: AppContext,
  group: Group,
  agentId: string,
  request: SendAgentRequest,
): Promise<Agent> {
  const agent = getAgent(ctx.db, agentId);
  if (!agent || agent.groupId !== group.id) throw notFound('Agent not found');
  if (agent.firedAt !== null) throw conflict(`${agent.name} has left the team. Hire them again.`);
  const target = getGroup(ctx.db, request.toGroupId);
  if (!target) throw notFound('The other group was not found');
  if (target.id === group.id) throw badRequest(`${agent.name} is already in this group`);

  const arrived = hire(ctx, target, {
    ...hireRequestOf(ctx, agent),
    name: request.name?.trim() || agent.name,
  });
  const memory = request.withMemory === false ? '' : await readMemory(ctx.dataDir, agent.id);
  const withMemory = memory.trim() !== '';
  if (withMemory) await bringMemory(ctx, target, arrived, memory, `"${group.name}"`);

  const detail = { from: group.id, to: target.id, as: arrived.name, withMemory };
  logEvent(ctx.db, { groupId: group.id, agentId: agent.id, kind: 'agent.sent', detail });
  logEvent(ctx.db, { groupId: target.id, agentId: arrived.id, kind: 'agent.arrived', detail });
  postNotice(
    ctx,
    target.id,
    `${arrived.name} came over from "${group.name}"${withMemory ? ' with what they remember' : ''}.`,
  );
  postNotice(
    ctx,
    group.id,
    `You sent ${agent.name} to "${target.name}"${arrived.name === agent.name ? '' : ` as ${arrived.name}`}${withMemory ? ' with what they remember' : ''}.${request.leave ? '' : ' They stay on this team too.'}`,
  );
  return arrived;
}

/** An agent as a hire request: everything needed to hire the same agent somewhere else. */
function hireRequestOf(ctx: AppContext, agent: Agent): HireRequest {
  return {
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    role: agent.role,
    roleId: ctx.roles.of(agent).id,
    instructions: agent.instructions,
    options: agent.options,
    settings: settingsOverrides(agent.role, agent.settings),
  };
}

/**
 * Gives a newly hired agent the memory it had elsewhere. Notes it already has here (someone of
 * that name worked in this group before) stay on top. The last lines say where the rest is
 * from, so notes about another project's code are not taken for this one's.
 */
async function bringMemory(
  ctx: AppContext,
  group: Group,
  agent: Agent,
  memory: string,
  from: string,
): Promise<void> {
  const own = (await readMemory(ctx.dataDir, agent.id)).trim();
  const note = [
    `## ${new Date().toISOString().slice(0, 10)} · Joined "${group.name}"`,
    '',
    `You came to this project from ${from}. The notes above are from other projects: keep what they say about the CEO and about how you work, and check anything about code against this project.`,
    '',
  ].join('\n');
  const room = MAX_MEMORY_FILE - note.length - 2;
  const brought = [own, memory.trim()].filter(Boolean).join('\n\n');
  // Like the prompt, a memory that grew too long keeps its newest notes.
  const kept = brought.length > room ? brought.slice(-room) : brought;
  await writeMemory(ctx.dataDir, agent.id, `${kept}\n\n${note}`);
}

function countAgents(count: number): string {
  return count === 1 ? '1 agent' : `${count} agents`;
}
