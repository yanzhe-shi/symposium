import type { AgentAdapter, ProviderId } from '@symposium/adapters';
import type { Db } from './db/database.js';
import type { Agent } from './protocol.js';
import type { RoleStore } from './roles.js';
import type { ChatHub } from './ws/chat-hub.js';

export type AdapterFactory = (agent: Agent) => AgentAdapter;

/** Everything the routes and services share. Built once per server. */
export interface AppContext {
  db: Db;
  hub: ChatHub;
  /** Symposium's own data folder: agent memory and worktrees live here. */
  dataDir: string;
  /** The roles agents can be hired into: built-in ones and the human's own. */
  roles: RoleStore;
  /** Where new projects go unless the human picks another folder. */
  projectsDir: string;
  /** The command that starts VS Code. */
  vscodeCommand: string;
  createAdapter: AdapterFactory;
  /**
   * Whether this computer can sandbox a process (Linux with bubblewrap), and with a provider:
   * that provider's CLI.
   */
  canSandbox: (provider?: ProviderId) => Promise<boolean>;
  /** Whether this computer can give a sandbox a network of its own (`pasta`). */
  canIsolateNetwork: () => Promise<boolean>;
  /** The port the engine answers on. Sandboxed processes never reach it. */
  enginePort: number;
}
