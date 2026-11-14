#!/usr/bin/env node
// The `symposium` command. Run it from anywhere.
// - In the packaged app the engine is compiled: packages/engine/dist/cli.js runs as it is.
// - In a checkout it is TypeScript: packages/engine/src/cli.ts runs with the tsx loader that
//   `pnpm install` put there.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Symposium needs Node.js 22 or newer. This is ${process.versions.node}.`);
  process.exit(1);
}

const engine = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'engine');
const compiled = join(engine, 'dist', 'cli.js');
let start;
if (existsSync(compiled)) {
  start = [compiled];
} else {
  try {
    const loader = createRequire(join(engine, 'package.json')).resolve('tsx');
    start = ['--import', pathToFileURL(loader).href, join(engine, 'src', 'cli.ts')];
  } catch {
    console.error(
      'Symposium is not installed yet. In the Symposium folder, run scripts/install.sh (or pnpm install && pnpm build).',
    );
    process.exit(1);
  }
}

const child = spawn(process.execPath, [...start, ...process.argv.slice(2)], { stdio: 'inherit' });
// Ctrl+C reaches the engine too, which then shuts down in its own time. Wait for it.
process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
