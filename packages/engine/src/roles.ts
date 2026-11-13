import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAccess, CommandMode } from '@symposium/adapters';
import type { RoleInfo, RoleKind } from './protocol.js';

/** What each role may touch unless the human chooses otherwise. Fixed by the engine, not by the model. */
export function roleAccess(role: RoleKind): AgentAccess {
  switch (role) {
    case 'worker':
      return 'edit';
    case 'lead':
    case 'reviewer':
      return 'read';
    case 'scribe':
      return 'none';
  }
}

/**
 * Whether a role gets a terminal unless the human chooses otherwise. Workers do, and every
 * command of theirs waits for the human. Nobody else does.
 */
export function roleCommands(role: RoleKind): CommandMode {
  return role === 'worker' ? 'ask' : 'off';
}

const ROLE_TEXT: readonly Omit<RoleInfo, 'defaultFiles' | 'defaultCommands'>[] = [
  {
    kind: 'lead',
    title: 'Lead',
    summary: 'Plans the work, assigns tasks and proposes hires. Reads code but does not edit it.',
  },
  {
    kind: 'worker',
    title: 'Worker',
    summary:
      'Builds what the lead assigns, on its own git branch and worktree. Asks you before running a command.',
  },
  {
    kind: 'reviewer',
    title: 'Reviewer',
    summary: 'Reviews diffs and asks for fixes. Reads code but does not edit it.',
  },
  {
    kind: 'scribe',
    title: 'Scribe',
    summary: 'Keeps project.md up to date whenever the team goes quiet. Use a small, cheap model.',
  },
];

export const ROLES: readonly RoleInfo[] = ROLE_TEXT.map((role) => ({
  ...role,
  defaultFiles: roleAccess(role.kind),
  defaultCommands: roleCommands(role.kind),
}));

export function isRoleKind(value: string): value is RoleKind {
  return ROLES.some((role) => role.kind === value);
}

/** One lead and one scribe per group. Any number of workers and reviewers. */
export const SINGLE_SEAT_ROLES: readonly RoleKind[] = ['lead', 'scribe'];

/** The role's built-in job description from `roles/<kind>.md`. */
export async function loadRoleText(rolesDir: string, role: RoleKind): Promise<string> {
  try {
    return (await readFile(join(rolesDir, `${role}.md`), 'utf8')).trim();
  } catch {
    return `# ${role}`;
  }
}

const ASK_FIRST_BLOCK = /<!-- ask-first -->\s*([\s\S]*?)\s*<!-- \/ask-first -->[^\S\n]*\n?\n?/g;

/**
 * Role files can wrap lines in `<!-- ask-first -->` … `<!-- /ask-first -->`. Those lines apply
 * only while the group's "lead asks before starting work" setting is on. The markers and the
 * blank lines around them are removed either way, so a list stays one list.
 */
export function applyPlanApproval(roleText: string, leadAsksFirst: boolean): string {
  return roleText.replace(ASK_FIRST_BLOCK, (_block, lines: string) =>
    leadAsksFirst ? `${lines}\n` : '',
  );
}
