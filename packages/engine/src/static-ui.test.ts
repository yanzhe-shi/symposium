import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db/database.js';
import { buildServer } from './server.js';
import { fileForUrl } from './static-ui.js';

describe('fileForUrl', () => {
  it('stays inside the folder', () => {
    expect(fileForUrl('/srv/ui', '/assets/app.js?v=1')).toBe('/srv/ui/assets/app.js');
    expect(fileForUrl('/srv/ui', '/../secret')).toBeUndefined();
    expect(fileForUrl('/srv/ui', '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined();
    expect(fileForUrl('/srv/ui', '/%zz')).toBeUndefined();
    expect(fileForUrl('/srv/ui-other', '/x')).toBe('/srv/ui-other/x');
  });
});

describe('serving the built page', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'symposium-ui-'));
    mkdirSync(join(root, 'ui', 'assets'), { recursive: true });
    writeFileSync(join(root, 'ui', 'index.html'), '<!doctype html><title>Symposium</title>');
    writeFileSync(join(root, 'ui', 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFileSync(join(root, 'secret.txt'), 'keep out');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function server(uiDir?: string) {
    const db = openDatabase(':memory:');
    const app = await buildServer({ db, dataDir: join(root, 'data'), uiDir });
    const get = (url: string, host = 'localhost:4400') => app.inject({ url, headers: { host } });
    return { app, get };
  }

  it('serves the page, its assets and the API from one place', async () => {
    const { app, get } = await server(join(root, 'ui'));
    const page = await get('/');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-cache');
    expect(page.body).toContain('<title>Symposium</title>');

    const asset = await get('/assets/app-abc123.js');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.body).toBe('console.log(1)');

    expect((await get('/api/health')).json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('serves assets when the folder is given with a trailing slash', async () => {
    const { app, get } = await server(`${join(root, 'ui')}/`);
    expect((await get('/assets/app-abc123.js')).body).toBe('console.log(1)');
    await app.close();
  });

  it('answers unknown API paths with an error, and anything else with the page', async () => {
    const { app, get } = await server(join(root, 'ui'));
    expect((await get('/api/nope')).statusCode).toBe(404);
    expect((await get('/api/nope')).json()).toEqual({ error: 'Nothing at /api/nope' });
    expect((await get('/some/page')).body).toContain('<title>Symposium</title>');
    await app.close();
  });

  it('never serves a file outside the page folder', async () => {
    const { app, get } = await server(join(root, 'ui'));
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt']) {
      expect((await get(url)).body).not.toContain('keep out');
    }
    await app.close();
  });

  it('keeps the localhost guard on the page too', async () => {
    const { app, get } = await server(join(root, 'ui'));
    expect((await get('/', 'evil.example')).statusCode).toBe(403);
    await app.close();
  });

  it('serves the API only when the page was not built', async () => {
    const { app, get } = await server(join(root, 'missing'));
    expect((await get('/')).statusCode).toBe(404);
    expect((await get('/api/health')).statusCode).toBe(200);
    await app.close();
  });
});
