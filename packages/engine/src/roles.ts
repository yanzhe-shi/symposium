import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAccess, CommandMode } from '@symposium/adapters';
import { badRequest, conflict, notFound } from './errors.js';
import type { RoleDraft, RoleInfo, RoleKind } from './protocol.js';

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

const BUILT_IN: readonly { kind: RoleKind; title: string; summary: string }[] = [
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

export const ROLE_KINDS: readonly RoleKind[] = BUILT_IN.map((role) => role.kind);

export function isRoleKind(value: string): value is RoleKind {
  return ROLE_KINDS.includes(value as RoleKind);
}

/** One lead and one scribe per group. Any number of workers and reviewers. */
export const SINGLE_SEAT_ROLES: readonly RoleKind[] = ['lead', 'scribe'];

export const MAX_ROLE_TITLE = 40;
export const MAX_ROLE_SUMMARY = 200;
export const MAX_ROLE_TEXT = 20_000;

/**
 * A role's id from its title: "UX Designer" gives "ux-designer". Ids name the role's file and
 * are what a hire refers to.
 */
export function roleIdFor(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/**
 * A role as text: a few `key: value` lines, a blank line, then the job description.
 *
 *     name: Designer
 *     kind: worker
 *     summary: Designs the screens and writes the CSS.
 *
 *     You design the product's screens…
 *
 * This is how custom roles are stored, and how a lead writes one in a ```role block.
 */
export function parseRoleFile(content: string): Partial<RoleDraft> {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const draft: Partial<RoleDraft> = {};
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  for (; i < lines.length; i += 1) {
    const header = /^(name|title|kind|summary)\s*:\s*(.*)$/i.exec(lines[i]!);
    if (!header) break;
    const key = header[1]!.toLowerCase();
    const value = header[2]!.trim();
    if (key === 'kind') draft.kind = value.toLowerCase() as RoleKind;
    else if (key === 'summary') draft.summary = value;
    else draft.title = value;
  }
  draft.text = lines.slice(i).join('\n').trim();
  return draft;
}

export function formatRoleFile(role: RoleDraft): string {
  return `name: ${role.title}\nkind: ${role.kind}\nsummary: ${role.summary}\n\n${role.text.trim()}\n`;
}

/** Checks a role someone wrote. Returns a clean copy or throws a 400 with the reason. */
export function validateRoleDraft(input: Partial<RoleDraft>): RoleDraft {
  const title = (input.title ?? '').replace(/\s+/g, ' ').trim();
  if (title === '' || title.length > MAX_ROLE_TITLE) {
    throw badRequest(`A role needs a name of 1 to ${MAX_ROLE_TITLE} characters`);
  }
  if (!/^[a-z]/.test(roleIdFor(title))) {
    throw badRequest('A role name starts with a letter');
  }
  if (!input.kind || !isRoleKind(input.kind)) {
    throw badRequest(`A role's kind is one of: ${ROLE_KINDS.join(', ')}`);
  }
  const summary = (input.summary ?? '').replace(/\s+/g, ' ').trim();
  if (summary.length > MAX_ROLE_SUMMARY) {
    throw badRequest(`A role's summary is at most ${MAX_ROLE_SUMMARY} characters`);
  }
  const text = (input.text ?? '').trim();
  if (text === '') throw badRequest('A role needs a job description');
  if (text.length > MAX_ROLE_TEXT) {
    throw badRequest(`A role's job description is at most ${MAX_ROLE_TEXT} characters`);
  }
  return { title, kind: input.kind, summary, text };
}

/**
 * The roles agents can be hired into. The four built-in roles come with Symposium, and the
 * human can rewrite their job descriptions. Custom roles are the human's own, or a lead's
 * proposal the human approved. Every role has a kind, one of the built-in four, which is how
 * the engine treats it: what it may touch, how many a team may have, who gets which messages.
 * The job description only tells the model what to do.
 *
 * Roles are small Markdown files in Symposium's data folder, read each time they are needed,
 * so an edit applies from the next turn.
 */
export class RoleStore {
  constructor(
    /** The repo's `roles/` folder with the built-in job descriptions. */
    private readonly builtInDir: string,
    /** Where the human's roles and edits are kept. */
    private readonly customDir: string,
  ) {}

  /** Built-in roles first, then custom ones by name. */
  list(): RoleInfo[] {
    const builtIn = BUILT_IN.map((role) => this.builtIn(role.kind));
    const custom = this.customFiles()
      .filter((id) => !isRoleKind(id))
      .map((id) => this.custom(id))
      .filter((role): role is RoleInfo => role !== undefined)
      .sort((a, b) => a.title.localeCompare(b.title));
    return [...builtIn, ...custom];
  }

  get(id: string): RoleInfo | undefined {
    if (isRoleKind(id)) return this.builtIn(id);
    return /^[a-z][a-z0-9-]*$/.test(id) ? this.custom(id) : undefined;
  }

  /** A role by its id or its name, whatever the case: "designer", "Designer", "UX designer". */
  find(nameOrId: string): RoleInfo | undefined {
    const wanted = nameOrId.trim().toLowerCase();
    return (
      this.get(wanted) ??
      this.get(roleIdFor(wanted)) ??
      this.list().find((role) => role.title.toLowerCase() === wanted)
    );
  }

  /** The role an agent works in. A custom role that was deleted falls back to its kind. */
  of(agent: { roleId: string; role: RoleKind }): RoleInfo {
    return this.get(agent.roleId) ?? this.builtIn(agent.role);
  }

  /** Adds a custom role. Throws if a role with that name exists. */
  create(input: Partial<RoleDraft>): RoleInfo {
    const draft = validateRoleDraft(input);
    const id = roleIdFor(draft.title);
    if (this.get(id)) throw conflict(`There is already a role called "${this.get(id)!.title}"`);
    this.write(id, draft);
    return this.get(id)!;
  }

  /**
   * Changes a role. A custom role keeps its id and kind, which agents already hired into it
   * depend on. Of a built-in role only the job description and the summary can change.
   */
  update(id: string, input: Partial<RoleDraft>): RoleInfo {
    const current = this.get(id);
    if (!current) throw notFound(`Role "${id}" not found`);
    const draft = validateRoleDraft({
      title: current.builtIn ? current.title : (input.title ?? current.title),
      kind: current.kind,
      summary: input.summary ?? current.summary,
      text: input.text ?? current.text,
    });
    this.write(id, draft);
    return this.get(id)!;
  }

  /** Deletes a custom role, or puts a built-in role back to how it came. */
  remove(id: string): void {
    if (!this.get(id)) throw notFound(`Role "${id}" not found`);
    rmSync(this.fileOf(id), { force: true });
  }

  private fileOf(id: string): string {
    return join(this.customDir, `${id}.md`);
  }

  private write(id: string, draft: RoleDraft): void {
    mkdirSync(this.customDir, { recursive: true });
    writeFileSync(this.fileOf(id), formatRoleFile(draft));
  }

  private customFiles(): string[] {
    try {
      return readdirSync(this.customDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.slice(0, -3));
    } catch {
      return [];
    }
  }

  private read(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  private builtIn(kind: RoleKind): RoleInfo {
    const base = BUILT_IN.find((role) => role.kind === kind)!;
    const original = this.read(join(this.builtInDir, `${kind}.md`))?.trim() ?? `# ${base.title}`;
    const saved = this.read(this.fileOf(kind));
    const edit = saved === undefined ? undefined : parseRoleFile(saved);
    return {
      id: kind,
      kind,
      title: base.title,
      summary: edit?.summary || base.summary,
      text: edit?.text || original,
      builtIn: true,
      edited: edit !== undefined,
      defaultFiles: roleAccess(kind),
      defaultCommands: roleCommands(kind),
    };
  }

  private custom(id: string): RoleInfo | undefined {
    const saved = this.read(this.fileOf(id));
    if (saved === undefined) return undefined;
    try {
      const draft = validateRoleDraft(parseRoleFile(saved));
      return {
        id,
        ...draft,
        builtIn: false,
        edited: false,
        defaultFiles: roleAccess(draft.kind),
        defaultCommands: roleCommands(draft.kind),
      };
    } catch {
      // A file edited by hand into something unreadable is skipped, not fatal.
      return undefined;
    }
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
