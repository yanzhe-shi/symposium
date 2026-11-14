#!/usr/bin/env node
// The `symposium` command. Starts packages/engine/src/cli.ts, which is TypeScript, with the
// tsx loader that `pnpm install` put there. Run it from anywhere.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Symposium needs Node.js 22 or newer. This is ${process.versions.node}.`);
  process.exit(1);
}

const engine = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'engine');
let loader;
try {
  loader = createRequire(join(engine, 'package.json')).resolve('tsx');
} catch {
  console.error(
    'Symposium is not installed yet. In the Symposium folder, run scripts/install.sh (or pnpm install && pnpm build).',
  );
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ['--import', pathToFileURL(loader).href, join(engine, 'src', 'cli.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
// Ctrl+C reaches the engine too, which then shuts down in its own time. Wait for it.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
