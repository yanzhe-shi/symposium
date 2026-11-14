import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** The file inside `root` that a URL path names, or undefined when it would leave `root`. */
export function fileForUrl(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '');
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const file = normalize(join(root, decoded));
  return file === root || file.startsWith(root + sep) ? file : undefined;
}

/**
 * Serves the built chat page from the engine itself, so an installed Symposium is one program
 * on one port. Does nothing when the page has not been built: during development Vite serves
 * it. Returns whether the page is being served.
 */
export function registerUi(app: FastifyInstance, uiDir: string): boolean {
  // `resolve` also drops a trailing slash, which would break the inside-the-folder check.
  const root = resolve(uiDir);
  const index = join(root, 'index.html');
  if (!existsSync(index)) return false;

  app.get('/*', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    // An unknown API path is a mistake to report, not a page to show.
    if (path === '/api' || path.startsWith('/api/') || path === '/ws') {
      return reply.code(404).send({ error: `Nothing at ${path}` });
    }
    const wanted = fileForUrl(root, path);
    const isFile = wanted !== undefined && (await stat(wanted).catch(() => undefined))?.isFile();
    // Anything that is not a file is a page of the app, which starts from index.html.
    const file = isFile ? wanted : index;
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    return (
      reply
        .type(type)
        // Vite names assets after their content, so those never change. The page itself is
        // always asked for again, so an update shows at the next reload.
        .header(
          'cache-control',
          file.startsWith(join(root, 'assets') + sep)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        )
        .send(await readFile(file))
    );
  });
  return true;
}
