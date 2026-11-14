import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type {
  Agent,
  AgentSettings,
  HireRequest,
  ProviderId,
  ProviderOptions,
  RoleKind,
} from '../protocol.js';
import { resolveSettings, settingsOverrides } from '../settings.js';

interface AgentRow {
  id: string;
  group_id: string;
  name: string;
  provider: ProviderId;
  model: string;
  role: RoleKind;
  role_id: string | null;
  instructions: string;
  options: string;
  settings: string;
  created_at: number;
  fired_at: number | null;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    role: row.role,
    roleId: row.role_id ?? row.role,
    instructions: row.instructions,
    options: JSON.parse(row.options) as ProviderOptions,
    settings: resolveSettings(row.role, JSON.parse(row.settings) as Partial<AgentSettings>),
    createdAt: row.created_at,
    firedAt: row.fired_at,
  };
}

/** Active agents only, unless `includeFired` is set. Ordered by hire time. */
export function listAgents(db: Db, groupId: string, { includeFired = false } = {}): Agent[] {
  const rows = db
    .prepare(
      `SELECT * FROM agents WHERE group_id = ? ${includeFired ? '' : 'AND fired_at IS NULL'}
       ORDER BY created_at, rowid`,
    )
    .all(groupId) as AgentRow[];
  return rows.map(toAgent);
}

export function getAgent(db: Db, id: string): Agent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
  return row ? toAgent(row) : undefined;
}

/** Any agent (active or fired) in the group with this name, ignoring case. */
export function findAgentByName(db: Db, groupId: string, name: string): Agent | undefined {
  const row = db
    .prepare('SELECT * FROM agents WHERE group_id = ? AND lower(name) = lower(?)')
    .get(groupId, name) as AgentRow | undefined;
  return row ? toAgent(row) : undefined;
}

/**
 * Hires an agent. Rehiring a fired agent's name brings that agent back with the new settings,
 * so its memory and history carry over.
 */
export function hireAgent(
  db: Db,
  groupId: string,
  hire: HireRequest,
  now: number = Date.now(),
): Agent {
  const previous = findAgentByName(db, groupId, hire.name);
  if (previous) {
    if (previous.firedAt === null) throw new Error(`${previous.name} is already on the team`);
    writeAgent(db, previous.id, hire);
    db.prepare('UPDATE agents SET fired_at = NULL WHERE id = ?').run(previous.id);
    return getAgent(db, previous.id)!;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO agents (id, group_id, name, provider, model, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, hire.name, hire.provider, hire.model, hire.role, now);
  writeAgent(db, id, hire);
  return getAgent(db, id)!;
}

/** Replaces everything about an agent that a hire describes. */
function writeAgent(db: Db, id: string, hire: HireRequest): void {
  db.prepare(
    `UPDATE agents SET name = ?, provider = ?, model = ?, role = ?, role_id = ?, instructions = ?,
     options = ?, settings = ? WHERE id = ?`,
  ).run(
    hire.name,
    hire.provider,
    hire.model,
    hire.role,
    hire.roleId && hire.roleId !== hire.role ? hire.roleId : null,
    hire.instructions ?? '',
    JSON.stringify(hire.options ?? {}),
    JSON.stringify(settingsOverrides(hire.role, hire.settings ?? {})),
    id,
  );
}

/** Changes an agent in place. `hire` is the agent's complete new description. */
export function updateAgent(db: Db, id: string, hire: HireRequest): Agent | undefined {
  writeAgent(db, id, hire);
  return getAgent(db, id);
}

export function fireAgent(db: Db, id: string, now: number = Date.now()): Agent | undefined {
  db.prepare('UPDATE agents SET fired_at = ? WHERE id = ? AND fired_at IS NULL').run(now, id);
  return getAgent(db, id);
}
