import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { buildServer } from './server.js';
import { ensureDefaultGroup } from './store/groups.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
ensureDefaultGroup(db);

const app = await buildServer({ db, logger: true });
app.log.info(`Using database at ${config.dbPath}`);

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down`);
  await app.close();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
