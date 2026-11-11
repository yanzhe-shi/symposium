import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses loopback, the default port and a database in the home folder', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.dbPath).toMatch(/\.symposium[/\\]symposium\.db$/);
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({ SYMPOSIUM_PORT: '5000', SYMPOSIUM_DB: '/tmp/test.db' });
    expect(config.port).toBe(5000);
    expect(config.dbPath).toBe('/tmp/test.db');
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ SYMPOSIUM_PORT: 'abc' })).toThrow(/SYMPOSIUM_PORT/);
  });
});
