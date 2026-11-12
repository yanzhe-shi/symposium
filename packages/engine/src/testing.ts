// Helpers for engine tests. Every test app uses temp folders and mock adapters only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAdapter } from '@symposium/adapters';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import type { AdapterFactory } from './context.js';
import { openDatabase, type Db } from './db/database.js';
import type { Agent } from './protocol.js';
import { buildServer } from './server.js';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  /** Symposium data folder for this test. */
  dataDir: string;
  /** Scratch folder for project folders. */
  workDir: string;
  /** Mock adapter per agent name, created on first use. Replace entries to script replies. */
  mocks: Map<string, MockAdapter>;
  request: (options: InjectOptions) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

export async function createTestApp(
  options: { createAdapter?: AdapterFactory; scribeDelayMs?: number } = {},
): Promise<TestApp> {
  const root = mkdtempSync(join(tmpdir(), 'symposium-test-'));
  const dataDir = join(root, 'data');
  const workDir = join(root, 'work');
  const db = openDatabase(':memory:');
  const mocks = new Map<string, MockAdapter>();
  const mockFactory: AdapterFactory = (agent: Agent) => {
    let mock = mocks.get(agent.name);
    if (!mock) {
      mock = new MockAdapter([{ text: `${agent.name} here.` }]);
      mocks.set(agent.name, mock);
    }
    return mock;
  };
  const app = await buildServer({
    db,
    dataDir,
    createAdapter: options.createAdapter ?? mockFactory,
    // Tests don't wait for the group to stay quiet before the scribe runs, unless they ask to.
    scribeDelayMs: options.scribeDelayMs ?? 0,
  });
  return {
    app,
    db,
    dataDir,
    workDir,
    mocks,
    request: (inject) =>
      app.inject({
        ...inject,
        headers: { host: 'localhost:4400', ...(inject.headers ?? {}) },
      }),
    close: async () => {
      await app.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Polls until `check` passes. For waiting on background agent runs. */
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
