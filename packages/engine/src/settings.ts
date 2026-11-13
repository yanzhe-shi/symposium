import { EFFORT_LEVELS } from '@symposium/adapters';
import { badRequest } from './errors.js';
import type { AgentSettings, CommandMode, FileAccess, RoleKind } from './protocol.js';
import { roleAccess, roleCommands } from './roles.js';

export const FILE_ACCESS: readonly FileAccess[] = ['none', 'read', 'edit'];
export const COMMAND_MODES: readonly CommandMode[] = ['off', 'ask', 'allowlist', 'auto'];
export const MAX_ALLOWLIST_ENTRIES = 50;
export const MAX_ALLOWLIST_ENTRY_LENGTH = 200;

/**
 * What an agent gets when the human has chosen nothing: file access by role, the provider's own
 * effort, and a terminal for workers only, where every command waits for the human.
 */
export function defaultSettings(role: RoleKind): AgentSettings {
  return {
    files: roleAccess(role),
    commands: roleCommands(role),
    allowlist: [],
    effort: 'default',
  };
}

/** The agent's settings: its role's defaults with the human's choices on top. */
export function resolveSettings(role: RoleKind, overrides: Partial<AgentSettings>): AgentSettings {
  return { ...defaultSettings(role), ...overrides };
}

/**
 * The part of `settings` that differs from the role's defaults. Only this is stored, so a
 * setting nobody chose keeps following the role.
 */
export function settingsOverrides(
  role: RoleKind,
  settings: Partial<AgentSettings>,
): Partial<AgentSettings> {
  const defaults = defaultSettings(role);
  const overrides: Partial<AgentSettings> = {};
  if (settings.files !== undefined && settings.files !== defaults.files) {
    overrides.files = settings.files;
  }
  if (settings.commands !== undefined && settings.commands !== defaults.commands) {
    overrides.commands = settings.commands;
  }
  if (settings.allowlist !== undefined && settings.allowlist.length > 0) {
    overrides.allowlist = settings.allowlist;
  }
  if (settings.effort !== undefined && settings.effort !== defaults.effort) {
    overrides.effort = settings.effort;
  }
  return overrides;
}

/** Checks settings sent by the human. Returns a clean copy or throws a 400 with the reason. */
export function validateSettings(role: RoleKind, input: unknown): Partial<AgentSettings> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw badRequest('Settings must be an object');
  const { files, commands, allowlist, effort, ...unknown } = input as Record<string, unknown>;
  const extra = Object.keys(unknown);
  if (extra.length > 0) throw badRequest(`Unknown setting "${extra[0]}"`);

  const clean: Partial<AgentSettings> = {};
  if (files !== undefined) {
    if (!FILE_ACCESS.includes(files as FileAccess)) {
      throw badRequest(`File access must be one of: ${FILE_ACCESS.join(', ')}`);
    }
    // The scribe only returns the text of project.md, which the engine writes.
    if (role === 'scribe' && files !== 'none') {
      throw badRequest('The scribe works without file access. Choose another role to give access.');
    }
    clean.files = files as FileAccess;
  }
  if (commands !== undefined) {
    if (!COMMAND_MODES.includes(commands as CommandMode)) {
      throw badRequest(`Command mode must be one of: ${COMMAND_MODES.join(', ')}`);
    }
    // The scribe only writes project.md, through the engine.
    if (role === 'scribe' && commands !== 'off') {
      throw badRequest('The scribe has no terminal. Choose another role to allow commands.');
    }
    clean.commands = commands as CommandMode;
  }
  if (allowlist !== undefined) {
    if (!Array.isArray(allowlist) || allowlist.some((entry) => typeof entry !== 'string')) {
      throw badRequest('The allow-list must be a list of command patterns');
    }
    const entries = [...new Set((allowlist as string[]).map((entry) => entry.trim()))].filter(
      Boolean,
    );
    if (entries.length > MAX_ALLOWLIST_ENTRIES) {
      throw badRequest(`The allow-list can hold at most ${MAX_ALLOWLIST_ENTRIES} patterns`);
    }
    if (
      entries.some((entry) => entry.length > MAX_ALLOWLIST_ENTRY_LENGTH || /[\r\n]/.test(entry))
    ) {
      throw badRequest(
        `Each allow-list pattern is one line of at most ${MAX_ALLOWLIST_ENTRY_LENGTH} characters`,
      );
    }
    clean.allowlist = entries;
  }
  if (effort !== undefined) {
    if (!EFFORT_LEVELS.includes(effort as AgentSettings['effort'])) {
      throw badRequest(`Effort must be one of: ${EFFORT_LEVELS.join(', ')}`);
    }
    clean.effort = effort as AgentSettings['effort'];
  }
  return clean;
}
