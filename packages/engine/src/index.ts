import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { buildServer } from './server.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);

const app = await buildServer({
  db,
  dataDir: config.dataDir,
  rolesDir: config.rolesDir,
  logger: true,
});
app.log.info(`Using data folder ${config.dataDir} and database ${config.dbPath}`);

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down`);
  await app.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
