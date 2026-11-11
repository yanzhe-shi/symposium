import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db/database.js';
import type { Message, ServerEvent } from './protocol.js';
import { MAX_MESSAGE_LENGTH } from './routes/messages.js';
import { createGroup } from './store/groups.js';
import { createTestApp, waitFor, type TestApp } from './testing.js';

let testApp: TestApp;
let db: Db;
let app: FastifyInstance;
let groupId: string;

beforeEach(async () => {
  testApp = await createTestApp();
  ({ db, app } = testApp);
  groupId = createGroup(db, { name: 'General' }).id;
});

afterEach(async () => {
  await testApp.close();
});

function postMessage(body: unknown, headers: Record<string, string> = {}, toGroup = groupId) {
  return app.inject({
    method: 'POST',
    url: `/api/groups/${toGroup}/messages`,
    headers: { host: 'localhost:4400', ...headers },
    payload: body as object,
  });
}

describe('HTTP API', () => {
  it('reports health', async () => {
    const res = await app.inject({ url: '/api/health', headers: { host: 'localhost' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('lists groups', async () => {
    const res = await app.inject({ url: '/api/groups', headers: { host: 'localhost' } });
    expect(res.json()).toEqual([expect.objectContaining({ id: groupId, name: 'General' })]);
  });

  it('creates a human message and returns 201', async () => {
    const res = await postMessage({ body: 'hello team' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ groupId, authorKind: 'human', body: 'hello team' });
  });

  it('returns messages in order', async () => {
    await postMessage({ body: 'one' });
    await postMessage({ body: 'two' });
    const res = await app.inject({
      url: `/api/groups/${groupId}/messages`,
      headers: { host: 'localhost' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Message[]).map((m) => m.body)).toEqual(['one', 'two']);
  });

  it('supports afterId when listing', async () => {
    const first = (await postMessage({ body: 'one' })).json() as Message;
    await postMessage({ body: 'two' });
    const res = await app.inject({
      url: `/api/groups/${groupId}/messages?afterId=${first.id}`,
      headers: { host: 'localhost' },
    });
    expect((res.json() as Message[]).map((m) => m.body)).toEqual(['two']);
  });

  it.each([
    ['an empty body', { body: '' }],
    ['a blank body', { body: '   \n ' }],
    ['a missing body', {}],
    ['a non-string body', { body: { text: 'hi' } }],
    ['extra fields', { body: 'hi', authorKind: 'agent' }],
    ['a body that is too long', { body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }],
  ])('rejects %s with 400', async (_label, payload) => {
    const res = await postMessage(payload);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for an unknown group', async () => {
    expect((await postMessage({ body: 'hi' }, {}, 'missing')).statusCode).toBe(404);
    const res = await app.inject({
      url: '/api/groups/missing/messages',
      headers: { host: 'localhost' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects requests from another website', async () => {
    const res = await postMessage({ body: 'hi' }, { origin: 'https://evil.com' });
    expect(res.statusCode).toBe(403);
    const list = await app.inject({
      url: `/api/groups/${groupId}/messages`,
      headers: { host: 'localhost' },
    });
    expect(list.json()).toEqual([]);
  });

  it('rejects a non-local Host header (DNS rebinding)', async () => {
    const res = await app.inject({ url: '/api/health', headers: { host: 'evil.com' } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts requests from the local UI origin', async () => {
    const res = await postMessage({ body: 'hi' }, { origin: 'http://localhost:5173' });
    expect(res.statusCode).toBe(201);
  });
});

describe('WebSocket', () => {
  let baseUrl: string;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('No server address');
    baseUrl = `127.0.0.1:${address.port}`;
  });

  afterEach(() => {
    for (const socket of openSockets.splice(0)) socket.close();
  });

  async function connect(toGroup: string): Promise<{ socket: WebSocket; events: ServerEvent[] }> {
    const socket = new WebSocket(`ws://${baseUrl}/ws?groupId=${toGroup}`);
    openSockets.push(socket);
    const events: ServerEvent[] = [];
    socket.addEventListener('message', (event) => {
      events.push(JSON.parse(String(event.data)) as ServerEvent);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('WebSocket failed to open')), {
        once: true,
      });
    });
    return { socket, events };
  }

  async function post(toGroup: string, body: string): Promise<Message> {
    const res = await fetch(`http://${baseUrl}/api/groups/${toGroup}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Message;
  }

  it('pushes new messages to every client in the group', async () => {
    const a = await connect(groupId);
    const b = await connect(groupId);
    const message = await post(groupId, 'live!');

    await waitFor(() => a.events.length === 1 && b.events.length === 1);
    expect(a.events[0]).toEqual({ type: 'message.created', message });
    expect(b.events[0]).toEqual({ type: 'message.created', message });
  });

  it('does not push messages from other groups', async () => {
    const other = createGroup(db, { name: 'Other' });
    const listener = await connect(groupId);
    const otherListener = await connect(other.id);

    await post(other.id, 'not for you');
    await waitFor(() => otherListener.events.length === 1);
    // Give a stray broadcast time to arrive before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listener.events).toEqual([]);
  });

  it('refuses a socket for an unknown group', async () => {
    const res = await app.inject({
      url: '/ws?groupId=missing',
      headers: { host: 'localhost', connection: 'upgrade', upgrade: 'websocket' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a socket opened from another website', async () => {
    const res = await app.inject({
      url: `/ws?groupId=${groupId}`,
      headers: {
        host: 'localhost',
        origin: 'https://evil.com',
        connection: 'upgrade',
        upgrade: 'websocket',
      },
    });
    expect(res.statusCode).toBe(403);
  });
});
