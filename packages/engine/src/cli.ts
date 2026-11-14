// The `symposium` command. `bin/symposium.mjs` runs this file.
import { runLauncher } from './launcher.js';

process.exit(await runLauncher(process.argv.slice(2)));
