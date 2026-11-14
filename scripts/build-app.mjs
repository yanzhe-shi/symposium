#!/usr/bin/env node
// Builds Symposium as a folder that runs with plain Node.js: no pnpm, no TypeScript, nothing
// to fetch. `scripts/package.sh` wraps that folder into an .rpm and a .deb.
//
//   node scripts/build-app.mjs            builds dist/app
//
// The folder mirrors the repo's layout, so the engine finds the page and the roles through
// the same relative paths as in development:
//
//   dist/app/
//     bin/symposium.mjs            the command
//     packages/engine/dist/        the engine, compiled
//     packages/engine/node_modules its packages, production only
//     packages/ui/dist/            the chat page
//     roles/  assets/  LICENSE  package.json
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'dist', 'app');
const build = join(root, 'dist', 'build');
const engine = join(app, 'packages', 'engine');
const { version, license } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const step = (text) => console.log(`\n==> ${text}`);
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

step('Building the chat page');
run('pnpm', ['--filter', '@symposium/ui', 'build']);

step('Compiling the engine');
rmSync(build, { recursive: true, force: true });
run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json']);

step('Collecting the packages the engine needs');
rmSync(app, { recursive: true, force: true });
mkdirSync(dirname(engine), { recursive: true });
run('pnpm', ['--filter', '@symposium/engine', 'deploy', '--prod', engine]);

// pnpm leaves the TypeScript sources and its own bookkeeping, which names folders on this
// machine. None of it is needed to run, and none of it may travel.
for (const name of readdirSync(engine)) {
  if (name !== 'node_modules') rmSync(join(engine, name), { recursive: true, force: true });
}
const modules = join(engine, 'node_modules');
const store = join(modules, '.pnpm');
for (const name of ['.modules.yaml', '.pnpm-workspace-state-v1.json']) {
  rmSync(join(modules, name), { force: true });
}
rmSync(join(store, 'lock.yaml'), { force: true });
for (const name of readdirSync(store)) {
  if (name.startsWith('@symposium+')) rmSync(join(store, name), { recursive: true, force: true });
}

// The adapters are our own code: compiled, they take the place of the copy pnpm made.
const adapters = join(modules, '@symposium', 'adapters');
rmSync(adapters, { recursive: true, force: true });
mkdirSync(adapters, { recursive: true });
cpSync(join(build, 'adapters', 'src'), join(adapters, 'dist'), { recursive: true });
writeJson(join(adapters, 'package.json'), {
  name: '@symposium/adapters',
  version,
  private: true,
  type: 'module',
  exports: { '.': './dist/index.js' },
});

cpSync(join(build, 'engine', 'src'), join(engine, 'dist'), { recursive: true });
writeJson(join(engine, 'package.json'), {
  name: '@symposium/engine',
  version,
  private: true,
  type: 'module',
});

// SQLite comes with a ready-made binary for every system. Keep the one for this build and
// drop the others, along with the C sources they were built from.
const platform = `${process.platform}-${process.arch}`;
const sqlite = join(modules, 'better-sqlite3');
for (const name of readdirSync(join(sqlite, 'prebuilds'))) {
  if (name !== `${platform}.node`) rmSync(join(sqlite, 'prebuilds', name));
}
if (!existsSync(join(sqlite, 'prebuilds', `${platform}.node`))) {
  throw new Error(`better-sqlite3 has no ready-made binary for ${platform}`);
}
for (const name of ['deps', 'src', 'binding.gyp']) {
  rmSync(join(sqlite, name), { recursive: true, force: true });
}

step('Adding the page, the roles and the command');
cpSync(join(root, 'packages', 'ui', 'dist'), join(app, 'packages', 'ui', 'dist'), {
  recursive: true,
});
for (const name of ['roles', 'assets', 'bin', 'LICENSE']) {
  cpSync(join(root, name), join(app, name), { recursive: true });
}
writeJson(join(app, 'package.json'), {
  name: 'symposium',
  version,
  license,
  private: true,
  type: 'module',
});
rmSync(build, { recursive: true, force: true });

// Nothing in the folder may say where, or by whom, it was built.
step('Checking that nothing of this machine is in the app');
const traces = [homedir(), userInfo().username, root].filter((text) => text.length > 2);
const leaks = [];
let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const shown = relative(app, path);
    if (traces.some((trace) => shown.includes(trace))) leaks.push(`name: ${shown}`);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    files += 1;
    bytes += info.size;
    const content = readFileSync(path);
    for (const trace of traces) {
      if (content.includes(trace)) leaks.push(`content: ${shown} mentions "${trace}"`);
    }
  }
})(app);
if (leaks.length > 0) {
  console.error(`Found traces of this machine:\n  ${leaks.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}

step('Trying it');
const out = execFileSync(process.execPath, [join(app, 'bin', 'symposium.mjs'), '--version'], {
  encoding: 'utf8',
  // The app must not lean on the repo around it.
  cwd: app,
}).trim();
if (out !== `symposium ${version}`) throw new Error(`The built app answered: ${out}`);

console.log(`\nBuilt Symposium ${version} for ${platform} in dist/app`);
console.log(
  `${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB. Run it: node dist/app/bin/symposium.mjs`,
);
