import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { EngineConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { buildServer } from './server.js';

export interface RunningEngine {
  app: FastifyInstance;
  /** Where the engine answers, such as http://127.0.0.1:4400. */
  url: string;
  /** Stops every agent, closes the server and the database. */
  stop: () => Promise<void>;
}

/** Opens the database and starts the server. Used by `pnpm dev` and by the `symposium` command. */
export async function startEngine(
  config: EngineConfig,
  logger: FastifyServerOptions['logger'] = true,
): Promise<RunningEngine> {
  const db = openDatabase(config.dbPath);
  const app = await buildServer({
    db,
    dataDir: config.dataDir,
    rolesDir: config.rolesDir,
    projectsDir: config.projectsDir,
    uiDir: config.uiDir,
    port: config.port,
    logger,
  });
  await app.listen({ host: config.host, port: config.port });
  return {
    app,
    url: `http://${config.host}:${config.port}`,
    stop: async () => {
      await app.close();
      db.close();
    },
  };
}
