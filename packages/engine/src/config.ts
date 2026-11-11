import { homedir } from 'node:os';
import { join } from 'node:path';

export interface EngineConfig {
  host: string;
  port: number;
  dbPath: string;
}

export const DEFAULT_PORT = 4400;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return {
    // Bind to loopback only. Symposium is a local tool and must not be reachable from the network.
    host: '127.0.0.1',
    port: parsePort(env.SYMPOSIUM_PORT) ?? DEFAULT_PORT,
    dbPath: env.SYMPOSIUM_DB ?? join(homedir(), '.symposium', 'symposium.db'),
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
