#!/usr/bin/env node
// Checks a running Symposium from the outside: the page, the API, the database, git and a
// turn of a mock team. Uses no AI and costs nothing.
//
//   node scripts/smoke-test.mjs [http://127.0.0.1:4400] [folder for a test project]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:4400';
const folder = process.argv[3] ?? join(mkdtempSync(join(tmpdir(), 'symposium-smoke-')), 'project');

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

function check(what, ok) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) process.exitCode = 1;
}

// The engine may still be starting.
for (let tries = 0; ; tries += 1) {
  try {
    await call('GET', '/api/health');
    break;
  } catch (error) {
    if (tries > 100) throw new Error(`No Symposium at ${base}`, { cause: error });
    await sleep(100);
  }
}

const page = await call('GET', '/');
check('serves the chat page', page.includes('<title>Symposium</title>'));
const script = /\/assets\/[^"]+\.js/.exec(page)?.[0];
check('serves the page’s script', Boolean(script) && (await call('GET', script)).length > 1000);

const roles = await call('GET', '/api/roles');
check('reads the built-in roles', roles.length >= 4 && roles[0].text.includes('You lead'));
const system = await call('GET', '/api/system');
check('finds git', system.git === true);

// Creating a group makes a git repo and writes to the database.
const group = await call('POST', '/api/groups', {
  name: 'Smoke test',
  folderPath: folder,
  starterTeam: 'mock',
});
const team = await call('GET', `/api/groups/${group.id}/agents`);
check('creates a project with a starter team', group.baseBranch === 'main' && team.length === 4);

await call('POST', `/api/groups/${group.id}/messages`, { body: 'Hello team' });
let reply;
for (let tries = 0; tries < 100 && !reply; tries += 1) {
  await sleep(100);
  const messages = await call('GET', `/api/groups/${group.id}/messages`);
  reply = messages.find((message) => message.authorKind === 'agent');
}
check('gets an answer from the lead', Boolean(reply) && reply.body.includes('Lea'));

await call('DELETE', `/api/groups/${group.id}`);
check(
  'deletes the group',
  (await call('GET', '/api/groups')).every((g) => g.id !== group.id),
);

console.log(process.exitCode ? '\nSomething is wrong.' : '\nAll good.');
