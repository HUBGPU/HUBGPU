// HUBGPU web server: static pages, no dependencies.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT || 9160);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_MODE = process.env.PUBLIC === '1'; // hides _-prefixed internal pages on the live server

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4',
};
const GZ = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);
const PAGES = { '/': 'index.html', '/app': 'app.html', '/docs': 'docs.html' };
const { default: api } = await import('./server/api.mjs');
const { bornTarget, serveIpfs } = await import('./server/launchpad.mjs');

const cache = new Map();
async function serveFile(res, file, req) {
  const s = await stat(file);
  if (s.isDirectory()) throw Object.assign(new Error('dir'), { code: 'EISDIR' });
  const ext = extname(file).toLowerCase();
  let c = cache.get(file);
  if (!c || c.mtime !== s.mtimeMs) {
    const body = await readFile(file);
    c = { mtime: s.mtimeMs, body, gz: GZ.has(ext) && body.length > 1024 ? gzipSync(body) : null };
    cache.set(file, c);
  }
  const headers = { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': /\/(fonts|vendor)\//.test(file) ? 'public, max-age=604800' : 'no-cache', 'x-content-type-options': 'nosniff' };
  if (c.gz && /gzip/.test(req.headers['accept-encoding'] || '')) { headers['content-encoding'] = 'gzip'; headers.vary = 'accept-encoding'; res.writeHead(200, headers).end(c.gz); }
  else res.writeHead(200, headers).end(c.body);
}

async function notFound(res, req) {
  try { const body = await readFile(join(ROOT, '404.html')); res.writeHead(404, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' }).end(body); }
  catch { res.writeHead(404, { 'content-type': TYPES['.html'] }).end('<h1>404</h1>'); }
}

http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Bad request'); return; }
  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500, { 'content-type': TYPES['.json'] }); res.end('{"error":"internal"}'); }
    return;
  }
  if (PUBLIC_MODE && /^\/_/.test(url.pathname)) return notFound(res, req);
  const clean = url.pathname.replace(/\/+$/, '') || '/';
  // each token's website link: /born/<id> opens its page once the launch is known
  // local fork tests point the pages at a test launchpad without touching public/config.js
  if (clean === '/config.js' && process.env.HUB_LAUNCHPAD) {
    const body = await readFile(join(ROOT, 'config.js'), 'utf8');
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' }).end(body + `\nObject.assign(window.HUBGPU_CONFIG, { launchpad: { address: ${JSON.stringify(process.env.HUB_LAUNCHPAD)}, block: ${Number(process.env.HUB_LAUNCHPAD_BLOCK || 0)} } });\n`);
    return;
  }
  const ipfs = clean.match(/^\/ipfs\/([A-Za-z0-9]+)$/);
  if (ipfs) return serveIpfs(res, ipfs[1]);
  const born = clean.match(/^\/born\/([0-9a-f]{16})$/);
  if (born) { res.writeHead(302, { location: bornTarget(born[1]) }).end(); return; }
  let path = PAGES[clean] || (/^\/t\/0x[0-9a-fA-F]{40}$/.test(clean) ? 'token.html' : normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
  if (path.endsWith('/')) path += 'index.html';
  try { await serveFile(res, join(ROOT, path), req); }
  catch {
    try { await serveFile(res, join(ROOT, path, 'index.html'), req); }
    catch { notFound(res, req); }
  }
}).listen(PORT, HOST, () => console.log(`HUBGPU → http://${HOST}:${PORT}`));
