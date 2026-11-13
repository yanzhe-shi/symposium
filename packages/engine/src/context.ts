import type { AgentAdapter } from '@symposium/adapters';
import type { Db } from './db/database.js';
import type { Agent } from './protocol.js';
import type { ChatHub } from './ws/chat-hub.js';

export type AdapterFactory = (agent: Agent) => AgentAdapter;

/** Everything the routes and services share. Built once per server. */
export interface AppContext {
  db: Db;
  hub: ChatHub;
  /** Symposium's own data folder: agent memory and worktrees live here. */
  dataDir: string;
  rolesDir: string;
  /** Where new projects go unless the human picks another folder. */
  projectsDir: string;
  /** The command that starts VS Code. */
  vscodeCommand: string;
  createAdapter: AdapterFactory;
}
