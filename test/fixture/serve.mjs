/**
 * A tiny static server for the fixture, because file:// blocks fetch().
 *
 *   npm run serve            → http://localhost:8765/?state=waiting
 *
 * The page's poll URL is /status, which answers with status/<state>.json —
 * the state comes from the page's query string, so every state of the
 * contract can be looked at without a shop. `?state=partial&then=settled`
 * answers partial first and settled from the third poll on, to watch the
 * transition and the success view.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = new URL('./', import.meta.url).pathname;
const DIST = new URL('../../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json' };

const polls = new Map();

createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  try {
    if (url.pathname === '/status') {
      const state = url.searchParams.get('state') || 'waiting';
      const then = url.searchParams.get('then');
      const key = state + '|' + then;
      const n = (polls.get(key) || 0) + 1;
      polls.set(key, n);
      const which = then && n >= 3 ? then : state;
      const body = await readFile(join(ROOT, 'status', which + '.json'), 'utf8');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(body);
      return;
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.startsWith('/dist/') ? join(DIST, path.slice(6)) : join(ROOT, path);
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
}).listen(8765, () => console.log('fixture: http://localhost:8765/?state=waiting  (states: waiting, partial, wrong_asset, expired; &then=settled)'));
