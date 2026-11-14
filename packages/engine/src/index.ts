// The engine on its own, with full logging. `pnpm dev` runs this beside Vite.
// To use Symposium, run the `symposium` command instead (see cli.ts).
import { loadConfig } from './config.js';
import { startEngine } from './start.js';

const config = loadConfig();
const engine = await startEngine(config);
engine.app.log.info(`Using data folder ${config.dataDir} and database ${config.dbPath}`);

async function shutdown(signal: string): Promise<void> {
  engine.app.log.info(`Received ${signal}, shutting down`);
  await engine.stop();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
