import type { Agent, RoleInfo } from '@symposium/engine/protocol';

/** The name of an agent's role: the kind for a built-in role, the title of a custom one. */
export function roleLabel(
  agent: Pick<Agent, 'role' | 'roleId'>,
  roles: readonly RoleInfo[],
): string {
  const role = roles.find((candidate) => candidate.id === agent.roleId);
  return role && !role.builtIn ? role.title : agent.role;
}

/** A small label with an agent's role, coloured by how the engine treats that role. */
export function RoleBadge({
  agent,
  roles,
}: {
  agent: Pick<Agent, 'role' | 'roleId'>;
  roles: readonly RoleInfo[];
}) {
  return <span className={`role-badge role-${agent.role}`}>{roleLabel(agent, roles)}</span>;
}
