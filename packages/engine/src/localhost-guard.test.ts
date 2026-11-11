import { describe, expect, it } from 'vitest';
import { isLocalHostHeader, isLocalOrigin } from './localhost-guard.js';

describe('isLocalHostHeader', () => {
  it.each(['localhost', 'localhost:4400', '127.0.0.1:5173', '[::1]:4400', 'LOCALHOST:1'])(
    'accepts %s',
    (host) => expect(isLocalHostHeader(host)).toBe(true),
  );

  it.each([undefined, '', 'evil.com', 'localhost.evil.com:4400', '10.0.0.5:4400'])(
    'rejects %s',
    (host) => expect(isLocalHostHeader(host)).toBe(false),
  );
});

describe('isLocalOrigin', () => {
  it.each([undefined, 'http://localhost:5173', 'http://127.0.0.1:4400', 'http://[::1]:5173'])(
    'accepts %s',
    (origin) => expect(isLocalOrigin(origin)).toBe(true),
  );

  it.each(['https://evil.com', 'http://localhost.evil.com', 'null', 'not a url'])(
    'rejects %s',
    (origin) => expect(isLocalOrigin(origin)).toBe(false),
  );
});
