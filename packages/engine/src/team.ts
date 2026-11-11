import { isProviderId } from '@symposium/adapters';
import { postNotice } from './chat.js';
import type { AppContext } from './context.js';
import { badRequest, conflict, notFound } from './errors.js';
import type { Agent, Group, HireRequest } from './protocol.js';
import { isRoleKind, SINGLE_SEAT_ROLES } from './roles.js';
import { fireAgent, getAgent, hireAgent, listAgents } from './store/agents.js';
import { logEvent } from './store/events.js';

export const AGENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const RESERVED_NAMES = new Set(['you', 'ceo', 'all', 'everyone', 'team', 'system', 'symposium']);
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks a hire request. Returns a clean copy or throws a 400 with a readable reason. */
export function validateHire(input: HireRequest): HireRequest {
  const name = input.name?.trim() ?? '';
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw badRequest(
      'Agent names start with a letter and use only letters, digits, - or _ (up to 32 characters), so they can be @mentioned.',
    );
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw badRequest(`"${name}" is reserved. Pick another name.`);
  }
  if (!isProviderId(input.provider)) throw badRequest(`Unknown provider "${input.provider}"`);
  if (!isRoleKind(input.role)) throw badRequest(`Unknown role "${input.role}"`);
  const model = input.model?.trim() ?? '';
  if (model === '' || model.length > 100) throw badRequest('Model must be 1 to 100 characters');
  const instructions = input.instructions?.trim() ?? '';
  if (instructions.length > 8000) throw badRequest('Instructions must be under 8000 characters');

  const options = input.options ?? {};
  if (options.apiKeyEnv && !ENV_NAME_PATTERN.test(options.apiKeyEnv)) {
    throw badRequest(
      'API key variable must be the name of an environment variable, such as OPENAI_API_KEY. Never paste the key itself.',
    );
  }
  if (options.baseUrl && !/^https?:\/\/\S+$/.test(options.baseUrl)) {
    throw badRequest('Base URL must start with http:// or https://');
  }
  const cleanOptions = Object.fromEntries(
    Object.entries({
      command: options.command?.trim(),
      baseUrl: options.baseUrl?.trim(),
      apiKeyEnv: options.apiKeyEnv?.trim(),
    }).filter(([, value]) => value),
  );
  return {
    name,
    provider: input.provider,
    model,
    role: input.role,
    instructions,
    options: cleanOptions,
  };
}

/** Adds an agent to the group and tells the chat. Used by the human's hire form and approved proposals. */
export function hire(ctx: AppContext, group: Group, request: HireRequest): Agent {
  const clean = validateHire(request);
  if (!group.folderPath) {
    throw badRequest('This group has no project folder. Create a new group to hire agents.');
  }
  const team = listAgents(ctx.db, group.id);
  if (team.some((agent) => agent.name.toLowerCase() === clean.name.toLowerCase())) {
    throw conflict(`${clean.name} is already on the team`);
  }
  if (SINGLE_SEAT_ROLES.includes(clean.role)) {
    const holder = team.find((agent) => agent.role === clean.role);
    if (holder) throw conflict(`${holder.name} is already the ${clean.role}. Fire them first.`);
  }

  const agent = hireAgent(ctx.db, group.id, clean);
  logEvent(ctx.db, {
    groupId: group.id,
    agentId: agent.id,
    kind: 'agent.hired',
    detail: { ...clean },
  });
  ctx.hub.broadcast(group.id, { type: 'agents.changed' });
  postNotice(
    ctx,
    group.id,
    `${agent.name} joined as ${agent.role} (${agent.provider} · ${agent.model}).`,
  );
  return agent;
}

export function fire(ctx: AppContext, group: Group, agentId: string): Agent {
  const agent = getAgent(ctx.db, agentId);
  if (!agent || agent.groupId !== group.id) throw notFound('Agent not found');
  if (agent.firedAt !== null) throw conflict(`${agent.name} has already left the team`);
  const fired = fireAgent(ctx.db, agent.id)!;
  logEvent(ctx.db, { groupId: group.id, agentId: agent.id, kind: 'agent.fired' });
  ctx.hub.broadcast(group.id, { type: 'agents.changed' });
  postNotice(ctx, group.id, `${agent.name} left the team. Their branch and memory are kept.`);
  return fired;
}
