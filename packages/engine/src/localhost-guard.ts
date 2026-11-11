import type { FastifyReply, FastifyRequest } from 'fastify';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Hostname of a Host header value such as "localhost:4400" or "[::1]:5173". */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(':')[0] ?? '';
}

export function isLocalHostHeader(host: string | undefined): boolean {
  return host !== undefined && LOCAL_HOSTNAMES.has(hostnameOf(host.toLowerCase()));
}

/** Requests without an Origin (curl, tests, same-origin GETs) are allowed. */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Rejects requests that did not come from this machine's own pages.
 * The Host check blocks DNS rebinding; the Origin check stops any other website open in
 * the browser from posting into a chat or opening the WebSocket.
 */
export async function localhostGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isLocalHostHeader(request.headers.host) || !isLocalOrigin(request.headers.origin)) {
    await reply.code(403).send({ error: 'Forbidden: requests must come from localhost' });
  }
}
