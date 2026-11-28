/**
 * Serves a beta build under /ADOP0001/beta/ for local E2E without deploying.
 * Usage: node tools/release/preview-beta.mjs [--dist dist] [--port 4174]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dist = path.resolve(value('dist', 'dist'));
const port = Number(value('port', '4174'));
const prefix = '/ADOP0001/beta/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(prefix)) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  let relative = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
  if (relative.endsWith('/')) relative += 'index.html';
  const target = path.resolve(dist, relative);
  if (!target.startsWith(dist + path.sep)) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('directory');
    response.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream' });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`beta preview: http://127.0.0.1:${port}${prefix}`);
});