// Qubit Test API: issue a challenge seed, check the GPU's answer against an exact
// float64 run of the same circuit, keep the verified runs for the leaderboard.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomInt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkCircuit, cpuRun, topOutcomes, CHECK_N } from '../public/js/app/gates.js';
import { launchpadApi, lpStats } from './launchpad.mjs';

const FILE = fileURLToPath(new URL('../data/bench.jsonl', import.meta.url));
// Challenges are signed, not stored: a restart or a deploy never invalidates a test that is running.
// id = seed.issuedAt.hmac — valid for 30 minutes, usable once (used ids are kept in bench.jsonl itself).
const SECRET_FILE = fileURLToPath(new URL('../data/challenge.key', import.meta.url));
let SECRET = await readFile(SECRET_FILE).catch(() => null);
if (!SECRET || SECRET.length < 32) { SECRET = randomBytes(32); await mkdir(dirname(SECRET_FILE), { recursive: true }); await writeFile(SECRET_FILE, SECRET, { mode: 0o600 }); }
const CH_TTL = 30 * 60e3;
const sign = (seed, at) => createHmac('sha256', SECRET).update(`${seed}.${at}`).digest('base64url').slice(0, 32);
function openChallenge(id) {
  const m = String(id || '').match(/^(\d{1,10})\.(\d{13})\.([A-Za-z0-9_-]{32})$/);
  if (!m) return null;
  const want = Buffer.from(sign(m[1], m[2])), got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Date.now() - Number(m[2]) > CH_TTL) return null;
  return { seed: Number(m[1]) };
}
const lastPost = new Map();            // ip -> time
const TOL = 3e-4;

const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
async function body(req, max = 8192) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > max) throw new Error('too large'); }
  return JSON.parse(s || '{}');
}
async function rows() {
  try { return (await readFile(FILE, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function verify(seed, top) {
  const { re, im } = cpuRun(CHECK_N, checkCircuit(seed));
  const p = re.map((r, i) => r * r + im[i] * im[i]);
  const truth = topOutcomes(p);
  const floor = truth[truth.length - 1][1];
  if (!Array.isArray(top) || top.length !== truth.length) return false;
  const seen = new Set();
  for (const [i, q] of top) {
    if (!Number.isInteger(i) || i < 0 || i >= p.length || seen.has(i)) return false;
    seen.add(i);
    if (Math.abs(p[i] - q) > TOL || p[i] < floor - TOL) return false;
  }
  return true;
}

async function raw(req, max = 8192) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw new Error('too large'); parts.push(c); }
  return Buffer.concat(parts);
}
const jsonBody = async (req, max) => JSON.parse((await raw(req, max)).toString() || '{}');

export default async function api(req, res, url) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  try {
    if (await launchpadApi(req, res, url, { json: jsonBody, body: raw, send: json, ip })) return;
  } catch (e) {
    console.warn('api', url.pathname, e.message);
    return json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong. Try again.' });
  }

  if (url.pathname === '/api/bench/challenge' && req.method === 'GET') {
    const seed = randomInt(1, 2 ** 31 - 1), at = Date.now();
    const id = `${seed}.${at}.${sign(seed, at)}`;
    return json(res, 200, { id, seed, n: CHECK_N });
  }

  if (url.pathname === '/api/bench' && req.method === 'POST') {
    if (Date.now() - (lastPost.get(ip) || 0) < 20e3) return json(res, 429, { error: 'One submission every 20 seconds.' });
    let b;
    try { b = await body(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const ch = openChallenge(b.id);
    if (!ch) return json(res, 400, { error: 'This test is older than 30 minutes. Run it again, then submit.' });
    if ((await rows()).some((r) => r.ch === b.id)) return json(res, 409, { error: 'This result is already on the board.' });
    lastPost.set(ip, Date.now());
    if (!verify(ch.seed, b.top)) return json(res, 422, { error: 'The check circuit did not match the exact answer.' });
    const maxQ = Number(b.maxQ), gaups = Number(b.gaups), bestN = Number(b.bestN);
    if (!Number.isInteger(maxQ) || maxQ < 2 || maxQ > 30 || !(gaups >= 0 && gaups < 5000) || !Number.isInteger(bestN)) return json(res, 400, { error: 'bad numbers' });
    const clean = (s, n) => String(s || '').replace(/[^\w .,()\-·+@]/g, '').trim().slice(0, n);
    const row = {
      at: new Date().toISOString(), name: clean(b.name, 20), gpu: clean(b.gpu, 60) || 'Unknown GPU', desc: clean(b.desc, 80),
      backend: b.backend === 'cpu' ? 'cpu' : 'webgpu', maxQ, bestN, gaups: Math.round(gaups * 1000) / 1000, verified: true, ch: b.id,
    };
    await mkdir(dirname(FILE), { recursive: true });
    await appendFile(FILE, JSON.stringify(row) + '\n');
    return json(res, 200, { ok: true, row });
  }

  // the local deploy page records the launchpad it deployed (never on the live server)
  if (url.pathname === '/api/_local/launchpad' && req.method === 'POST' && process.env.PUBLIC !== '1' && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '')) {
    const b = JSON.parse((await raw(req)).toString() || '{}');
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(new URL('../data/launchpad-deployed.json', import.meta.url), JSON.stringify({ ...b, at: new Date().toISOString() }, null, 1));
    console.log('launchpad deployed', b);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/stats') {
    const r = await rows();
    return json(res, 200, { ...lpStats(), gpus: new Set(r.map((x) => x.gpu)).size, runs: r.length, maxQubits: r.reduce((m, x) => Math.max(m, x.maxQ), 0) });
  }

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const best = new Map();
    for (const r of await rows()) {
      const k = `${r.name}|${r.gpu}|${r.backend}`;
      const b = best.get(k);
      if (!b || r.maxQ > b.maxQ || (r.maxQ === b.maxQ && r.gaups > b.gaups)) best.set(k, r);
    }
    const list = [...best.values()].sort((a, b) => b.maxQ - a.maxQ || b.gaups - a.gaups).slice(0, 100);
    return json(res, 200, { rows: list.map(({ ch, ...r }) => r) });
  }
  json(res, 404, { error: 'not found' });
}
