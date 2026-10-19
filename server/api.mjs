// Qubit Test API: issue a challenge seed, check the GPU's answer against an exact
// float64 run of the same circuit, keep the verified runs for the leaderboard.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkCircuit, cpuRun, topOutcomes, CHECK_N } from '../public/js/app/gates.js';
import { launchpadApi, lpStats } from './launchpad.mjs';

const FILE = fileURLToPath(new URL('../data/bench.jsonl', import.meta.url));
const challenges = new Map();          // id -> { seed, at }
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
  for (const [id, c] of challenges) if (Date.now() - c.at > 15 * 60e3) challenges.delete(id);

  if (url.pathname === '/api/bench/challenge' && req.method === 'GET') {
    if (challenges.size > 5000) return json(res, 503, { error: 'busy' });
    const id = randomUUID(), seed = randomInt(1, 2 ** 31 - 1);
    challenges.set(id, { seed, at: Date.now() });
    return json(res, 200, { id, seed, n: CHECK_N });
  }

  if (url.pathname === '/api/bench' && req.method === 'POST') {
    if (Date.now() - (lastPost.get(ip) || 0) < 20e3) return json(res, 429, { error: 'One submission every 20 seconds.' });
    let b;
    try { b = await body(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const ch = challenges.get(b.id);
    if (!ch) return json(res, 400, { error: 'Challenge expired. Run the test again.' });
    challenges.delete(b.id);
    lastPost.set(ip, Date.now());
    if (!verify(ch.seed, b.top)) return json(res, 422, { error: 'The check circuit did not match the exact answer.' });
    const maxQ = Number(b.maxQ), gaups = Number(b.gaups), bestN = Number(b.bestN);
    if (!Number.isInteger(maxQ) || maxQ < 2 || maxQ > 30 || !(gaups >= 0 && gaups < 5000) || !Number.isInteger(bestN)) return json(res, 400, { error: 'bad numbers' });
    const clean = (s, n) => String(s || '').replace(/[^\w .,()\-·+]/g, '').trim().slice(0, n);
    const row = {
      at: new Date().toISOString(), name: clean(b.name, 20), gpu: clean(b.gpu, 60) || 'Unknown GPU', desc: clean(b.desc, 80),
      backend: b.backend === 'cpu' ? 'cpu' : 'webgpu', maxQ, bestN, gaups: Math.round(gaups * 1000) / 1000, verified: true,
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
    return json(res, 200, { rows: list });
  }
  json(res, 404, { error: 'not found' });
}
