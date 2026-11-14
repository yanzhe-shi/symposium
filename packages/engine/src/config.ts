import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EngineConfig {
  host: string;
  port: number;
  /** Where Symposium keeps its own data: database, agent memory and worktrees. */
  dataDir: string;
  dbPath: string;
  /** Folder with the built-in role files. */
  rolesDir: string;
  /** Where new projects go unless the human picks another folder. */
  projectsDir: string;
  /** The built chat page. Served by the engine when the folder exists. */
  uiDir: string;
}

export const DEFAULT_PORT = 4400;
/** Projects live in their own folders, apart from Symposium's data. */
export const DEFAULT_PROJECTS_DIR = join(homedir(), 'symposium-projects');

/** The chat page as `pnpm build` leaves it. */
export const BUILT_UI_DIR = fileURLToPath(new URL('../../ui/dist/', import.meta.url));

/** The repo's `roles/` folder. This file sits at packages/engine/src/config.ts. */
export const BUILT_IN_ROLES_DIR = fileURLToPath(new URL('../../../roles/', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const dataDir = env.SYMPOSIUM_HOME || join(homedir(), '.symposium');
  return {
    // Bind to loopback only. Symposium is a local tool and must not be reachable from the network.
    host: '127.0.0.1',
    port: parsePort(env.SYMPOSIUM_PORT) ?? DEFAULT_PORT,
    dataDir,
    dbPath: env.SYMPOSIUM_DB || join(dataDir, 'symposium.db'),
    rolesDir: env.SYMPOSIUM_ROLES_DIR || BUILT_IN_ROLES_DIR,
    projectsDir: env.SYMPOSIUM_PROJECTS_DIR || DEFAULT_PROJECTS_DIR,
    uiDir: env.SYMPOSIUM_UI_DIR || BUILT_UI_DIR,
  };
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`SYMPOSIUM_PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}
