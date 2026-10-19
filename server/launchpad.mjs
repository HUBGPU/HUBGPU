// Launchpad API. A token joins the HubGPU registry only after its launch transaction is read back from
// Robinhood Chain: it must be a Pons launch against ETH, its description must end with the birth tag and
// bitstring, and its creator fees must go to the wallet that sent it. A scan of the factory's TokenLaunched
// logs every 90 s catches launches whose page closed before reporting them.
//
// $HGPU utility is read from the chain, never from the page: a 16-qubit birth counts as rare only if the
// creator held enough $HGPU when it was registered, and the Featured row follows creators' live balances.
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { getAddress } from 'ethers';
import * as P from './pons.js';

const DATA = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const CFG_FILE = fileURLToPath(new URL('../public/config.js', import.meta.url));
const TAG = /Born on HubGPU · \|([01]{4,32})⟩/;
const BID = /\/born\/([0-9a-f]{16})\b/;
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const key = (a) => String(a).toLowerCase();

/* the same config.js the pages load (CA and holder thresholds), re-read when it changes */
let cfg = {}, cfgAt = 0;
async function config() {
  try {
    const st = await stat(CFG_FILE);
    if (st.mtimeMs !== cfgAt) {
      const ctx = { window: {} };
      vm.runInNewContext(await readFile(CFG_FILE, 'utf8'), ctx, { timeout: 200 });
      cfg = ctx.window.HUBGPU_CONFIG || {}; cfgAt = st.mtimeMs;
      if (process.env.HUB_CA) cfg.ca = process.env.HUB_CA;   // local fork tests only
      if (process.env.HUB_LAUNCHPAD) cfg.launchpad = { address: process.env.HUB_LAUNCHPAD, block: Number(process.env.HUB_LAUNCHPAD_BLOCK || 0) };
    }
  } catch (e) { console.warn('config:', e.message); }
  return cfg;
}
await config();

function store(file, init) {
  const path = join(DATA, file);
  const s = { v: init, async load() { try { s.v = JSON.parse(await readFile(path, 'utf8')); } catch { /* first run */ } }, async save() { await mkdir(DATA, { recursive: true }); await writeFile(path, JSON.stringify(s.v)); } };
  return s;
}
const LAUNCHES = store('launches.json', { list: [] });   // [{ token, curve, name, symbol, logo, bits, p, gpu, rare, bid, creator, tx, t, block }]
const SCAN = store('scan.json', { top: 0 });
await Promise.all([LAUNCHES.load(), SCAN.load()]);
const byToken = () => new Map(LAUNCHES.v.list.map((l) => [key(l.token), l]));

/* $HGPU balances (whole tokens) for a set of wallets; empty until the CA is set */
async function hgpuBalances(addrs) {
  const c = await config();
  const out = new Map();
  if (!isAddr(c.ca) || !addrs.length) return out;
  const r = await P.multicall(addrs.map((a) => ({ target: c.ca, iface: P.tokenI, fn: 'balanceOf', args: [a] })));
  addrs.forEach((a, i) => out.set(key(a), r[i] ? Number(r[i][0]) / 1e18 : 0));
  return out;
}

/* market: curve reserves every 20 s, ETH/USD every 5 min, creators' $HGPU every minute */
let ethUsd = 0, ethAt = 0, holdAt = 0;
const MARKET = new Map();
const FEATURED = new Set();
async function refreshMarket() {
  try {
    if (Date.now() - ethAt > 300e3) { ethUsd = await P.ethUsd(ethUsd); ethAt = Date.now(); }
    const list = LAUNCHES.v.list.map((l) => MARKET.get(key(l.token)) || { token: l.token, curve: l.curve });
    if (!list.length) return;
    await P.priceCurves(list, ethUsd);
    for (const m of list) MARKET.set(key(m.token), m);
    if (Date.now() - holdAt > 60e3) {
      holdAt = Date.now();
      const c = await config();
      const creators = [...new Set(LAUNCHES.v.list.map((l) => key(l.creator)))];
      const bal = await hgpuBalances(creators);
      FEATURED.clear();
      for (const [a, v] of bal) if (v >= (c.holder?.featured ?? Infinity)) FEATURED.add(a);
    }
  } catch (e) { console.warn('market:', e.message); }
}
setTimeout(refreshMarket, 1500); setInterval(refreshMarket, 20e3).unref();

const row = (l) => {
  const m = MARKET.get(key(l.token)) || {};
  return { token: l.token, curve: l.curve, name: l.name, symbol: l.symbol, logo: l.logo, bits: l.bits, p: l.p, gpu: l.gpu, rare: !!l.rare, featured: FEATURED.has(key(l.creator)),
    creator: l.creator, tx: l.tx, t: l.t, mcap: m.mcap || 0, progress: m.progress || 0, raised: m.raised || 0, grad: !!m.grad, priceEth: m.priceEth || 0 };
};

async function register(rc, extra = {}) {
  if (rc.pair !== P.NATIVE) throw Object.assign(new Error('HubGPU tokens trade against ETH'), { status: 400 });
  const have = byToken().get(key(rc.token));
  if (have) return { l: have, fresh: false };
  const [meta] = await P.fetchMeta([{ token: rc.token }]);
  const tag = String(meta.desc || '').match(TAG);
  if (!tag) throw Object.assign(new Error('This token was not born on HubGPU'), { status: 400 });
  const info = await P.lookupToken(rc.token);
  if (!info || (rc.from && key(info.feeTo) !== key(rc.from))) throw Object.assign(new Error('This token pays its fees to another wallet'), { status: 400 });
  const c = await config();
  // once the launchpad contract exists, new tokens count only when launched through it (that is where the fee is paid)
  const lp = isAddr(c.launchpad?.address) ? c.launchpad.address : '';
  const viaLp = !!lp && key(info.deployer) === key(lp);
  if (lp && !viaLp && (rc.block || 0) >= (c.launchpad.block || 0)) throw Object.assign(new Error('New HubGPU tokens launch through the HubGPU launchpad'), { status: 400 });
  let rare = false;
  if (tag[1].length >= 16) {
    if (viaLp) rare = true;   // the contract only accepts a 16-bit birth from a wallet holding enough $HGPU
    else {
      const bal = await hgpuBalances([info.feeTo]).catch(() => new Map());
      rare = (bal.get(key(info.feeTo)) || 0) >= (c.holder?.rare ?? Infinity);
    }
  }
  const l = {
    token: info.token, curve: info.curve, name: meta.name, symbol: String(meta.symbol).toUpperCase(), logo: meta.logo, bits: tag[1], rare,
    bid: String(meta.site || '').match(BID)?.[1] || '',
    p: Math.max(0, Math.min(1, Number(extra.p) || 0)), gpu: String(extra.gpu || '').replace(/[^\w .·,()+-]/g, '').slice(0, 60),
    creator: getAddress(info.feeTo), tx: rc.tx, t: rc.t || Date.now(), block: rc.block || 0, lp: viaLp,
  };
  LAUNCHES.v.list.push(l);
  await LAUNCHES.save();
  refreshMarket();
  births.unshift({ kind: 'born', token: l.token, symbol: l.symbol, who: l.creator, t: l.t, rare: l.rare });
  console.log('launch: $' + l.symbol, l.token, 'by', l.creator, rare ? '(rare)' : '');
  return { l, fresh: true };
}

let scanning = false;
async function scan() {
  if (scanning) return; scanning = true;
  try {
    const found = await P.fetchNewLaunches(SCAN.v.top, SCAN.v.top ? 6 : 2);
    if (found.length) SCAN.v.top = Math.max(SCAN.v.top, ...found.map((f) => f.block));
    const known = byToken();
    const fresh = found.filter((f) => !known.has(key(f.token)) && f.pair === P.NATIVE);
    if (fresh.length) {
      await P.fetchMeta(fresh);
      for (const f of fresh) if (TAG.test(f.desc || '')) await register({ ...f, from: '' }).catch((e) => console.warn('scan:', e.message));
    }
    await SCAN.save();
  } catch (e) { console.warn('scan:', e.message); }
  finally { scanning = false; }
}
setTimeout(scan, 5000); setInterval(scan, 90e3).unref();

/* trades per curve (explorer logs), cached briefly; the activity feed merges the newest ones with births */
const tradeCache = new Map();
async function tradesOf(curve, pages = 4) {
  const k = key(curve) + pages, hit = tradeCache.get(k);
  if (hit && Date.now() - hit.at < 10e3) return hit.v;
  const v = await P.trades(curve, pages, 18);
  tradeCache.set(k, { at: Date.now(), v });
  return v;
}
const births = LAUNCHES.v.list.slice().sort((a, b) => b.t - a.t).slice(0, 20).map((l) => ({ kind: 'born', token: l.token, symbol: l.symbol, who: l.creator, t: l.t, rare: !!l.rare }));
let activity = [];
async function refreshActivity() {
  try {
    const recent = LAUNCHES.v.list.slice().sort((a, b) => b.t - a.t).slice(0, 20);
    const rows = [];
    for (const l of recent) {
      const tr = await tradesOf(l.curve, 1).catch(() => []);
      for (const t of tr.slice(0, 8)) rows.push({ kind: t.side, token: l.token, symbol: l.symbol, who: t.who, eth: t.eth, t: t.t, tx: t.tx });
    }
    activity = [...rows, ...births.slice(0, 20)].sort((a, b) => b.t - a.t).slice(0, 40);
  } catch (e) { console.warn('activity:', e.message); }
}
setTimeout(refreshActivity, 8000); setInterval(refreshActivity, 45e3).unref();

async function candles(l, tf) {
  const trades = await tradesOf(l.curve, 4);
  const list = trades.filter((t) => t.tokens > 0).sort((a, b) => a.t - b.t);
  const k = P.PONS.supply * ethUsd, out = [];
  for (const t of list) {
    const ts = Math.floor(t.t / 1000 / tf) * tf, px = t.priceEth * k;
    const last = out[out.length - 1];
    if (last && last.time === ts) { last.high = Math.max(last.high, px); last.low = Math.min(last.low, px); last.close = px; last.volume += t.eth * ethUsd; }
    else out.push({ time: ts, open: last ? last.close : px, high: px, low: px, close: px, volume: t.eth * ethUsd });
  }
  const m = MARKET.get(key(l.token));
  if (out.length && m?.mcap && !m.grad) { const z = out[out.length - 1]; z.close = m.mcap; z.high = Math.max(z.high, m.mcap); z.low = Math.min(z.low, m.mcap); }
  return { candles: out, trades: trades.slice(0, 60).map(({ key: _, ...t }) => t) };
}

/* logo pinning: the seal the creator's GPU drew, pinned to IPFS through Pons's own uploader
   (the one ponsfamily.com/launchpad/create uses). Everything stays on Robinhood Chain and Pons. */
const PONS_PINNER = 'https://ponsfamily.com/api/ipfs/image';
async function pinLogo(img, name, symbol, ext = 'png') {
  if (process.env.LOGO_STUB) return 'ipfs://bafkreistubhubgpulocaltest'; // local fork tests never upload
  const type = ext === 'jpg' ? 'image/jpeg' : 'image/png';
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const form = new FormData();
      form.append('image', new Blob([img], { type }), `${(symbol || 'seal').toLowerCase()}.${ext}`);
      const r = await fetch(PONS_PINNER, { method: 'POST', body: form, headers: { Origin: 'https://ponsfamily.com', Referer: 'https://ponsfamily.com/launchpad/create' }, signal: AbortSignal.timeout(45_000) });
      const j = await r.json().catch(() => ({}));
      const cid = String(j.uri || '').match(/ipfs:\/\/([A-Za-z0-9]+)/)?.[1] || j.cid;
      if (r.ok && cid) return 'ipfs://' + cid;
      last = new Error(`Pons uploader ${r.status}`);
    } catch (e) { last = e; }
  }
  throw last;
}

const RPC_OK = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getCode']);
const hits = new Map();
function limited(name, ip, perMin) {
  const k = name + ip, now = Date.now(), arr = (hits.get(k) || []).filter((t) => now - t < 60e3);
  arr.push(now); hits.set(k, arr);
  return arr.length > perMin;
}

export const lpStats = () => ({
  born: LAUNCHES.v.list.length,
  rare: LAUNCHES.v.list.filter((l) => l.rare).length,
  mcap: LAUNCHES.v.list.reduce((s, l) => s + (MARKET.get(key(l.token))?.mcap || 0), 0),
  ethUsd,
});

/* token logos served from here: fetched from IPFS once, kept on disk, then immutable. Public gateways rate-limit
   (ipfs.io, dweb.link and w3s.link answer 429 from both the server and many home connections), so Pinata comes first. */
const GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/'];
const ipfsBusy = new Map();
const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[1] === 0x50 && b[2] === 0x4e ? 'image/png' : b.toString('ascii', 0, 4) === 'GIF8' ? 'image/gif' : b.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : '');
export async function serveIpfs(res, cid) {
  if (!/^[A-Za-z0-9]{40,100}$/.test(cid)) return res.writeHead(404).end();
  const file = join(DATA, 'ipfs', cid);
  let body = await readFile(file).catch(() => null);
  if (!body) {
    if (!ipfsBusy.has(cid)) ipfsBusy.set(cid, (async () => {
      for (const g of GATEWAYS) {
        try {
          const r = await fetch(g + cid, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
          if (!r.ok) continue;
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length > 3e6 || !sniff(b)) continue;
          await mkdir(join(DATA, 'ipfs'), { recursive: true });
          await writeFile(file, b);
          return b;
        } catch { /* next gateway */ }
      }
      return null;
    })().finally(() => setTimeout(() => ipfsBusy.delete(cid), 30_000)));
    body = await ipfsBusy.get(cid);
  }
  if (!body) return res.writeHead(404, { 'cache-control': 'no-store' }).end();
  res.writeHead(200, { 'content-type': sniff(body), 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }).end(body);
}

/** /born/<bid> → the token page once the launch is known (the website link written into each token) */
export function bornTarget(bid) {
  const l = LAUNCHES.v.list.find((x) => x.bid === bid);
  return l ? '/t/' + l.token : '/app';
}

/** returns true when it handled the request */
export async function launchpadApi(req, res, url, { json, body, send, ip }) {
  const path = url.pathname, q = url.searchParams;
  let m;
  if (path === '/api/terms') return send(res, 200, await P.terms(P.NATIVE)), true;
  if (path === '/api/launches' && req.method === 'GET') {
    let list = LAUNCHES.v.list.map(row);
    const s = (q.get('q') || '').trim().toLowerCase().replace(/^\$/, '');
    if (s) list = list.filter((r) => r.symbol.toLowerCase().includes(s) || r.name.toLowerCase().includes(s) || r.bits.includes(s.replace(/\s/g, '')) || key(r.token) === s);
    if (isAddr(q.get('creator'))) list = list.filter((r) => key(r.creator) === key(q.get('creator')));
    const sort = q.get('sort');
    list.sort(sort === 'mcap' ? (a, b) => b.mcap - a.mcap : sort === 'progress' ? (a, b) => b.progress - a.progress : (a, b) => b.t - a.t);
    return send(res, 200, { total: list.length, ethUsd, launches: list.slice(0, 200) }), true;
  }
  if (path === '/api/launches' && req.method === 'POST') {
    if (limited('reg', ip, 30)) return send(res, 429, { error: 'Too many requests' }), true;
    const b = await json(req);
    if (!/^0x[0-9a-fA-F]{64}$/.test(b.tx || '')) return send(res, 400, { error: 'Bad transaction hash' }), true;
    let rc = null;
    for (let i = 0; i < 8 && !rc; i++) {
      rc = await P.readLaunchTx(b.tx).catch((e) => { if (/failed|Not a Pons/.test(e.message)) throw Object.assign(e, { status: 400 }); return null; });
      if (!rc) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!rc) return send(res, 404, { error: 'Transaction not found yet. It will appear by itself in a minute.' }), true;
    const r = await register(rc, b);
    return send(res, r.fresh ? 201 : 200, row(r.l)), true;
  }
  if ((m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})(\/candles|\/holders)?$/))) {
    const l = byToken().get(key(m[1]));
    if (!l) return send(res, 404, { error: 'Not a HubGPU token' }), true;
    if (m[2] === '/candles') {
      const tf = [60, 300, 900, 3600, 14400].includes(+q.get('tf')) ? +q.get('tf') : 300;
      return send(res, 200, await candles(l, tf).catch(() => ({ candles: [], trades: [] }))), true;
    }
    if (m[2] === '/holders') return send(res, 200, await P.holders(l.token).catch(() => ({ count: 0, top: [] }))), true;
    const st = await P.coinState(l.token).catch(() => null);
    return send(res, 200, { ...row(l), state: st, ethUsd }), true;
  }
  if ((m = path.match(/^\/api\/ticker\/([A-Za-z0-9]{1,16})$/))) {
    const sym = m[1].toUpperCase();
    const l = LAUNCHES.v.list.find((x) => x.symbol === sym);
    return send(res, 200, { symbol: sym, taken: !!l, token: l?.token || '' }), true;
  }
  if (path === '/api/activity') return send(res, 200, { ethUsd, items: activity.length ? activity : births.slice(0, 20) }), true;
  if (path === '/api/holder') {
    const w = q.get('wallet'), c = await config();
    const out = { ca: isAddr(c.ca) ? c.ca : '', rareMin: c.holder?.rare ?? 0, featuredMin: c.holder?.featured ?? 0, balance: 0, rare: false, featured: false };
    if (isAddr(w) && out.ca) {
      const bal = await hgpuBalances([w]).catch(() => new Map());
      out.balance = bal.get(key(w)) || 0;
      out.rare = out.balance >= out.rareMin; out.featured = out.balance >= out.featuredMin;
    }
    return send(res, 200, out), true;
  }
  if (path === '/api/fees') {
    const w = q.get('wallet');
    if (!isAddr(w)) return send(res, 400, { error: 'Connect a wallet' }), true;
    const mine = LAUNCHES.v.list.filter((l) => key(l.creator) === key(w));
    const f = await P.feesFor(w, mine.map((l) => l.curve));
    return send(res, 200, { ...f, escrow: P.PONS.feeEscrow, curves: f.curves.map((x, i) => ({ ...x, token: mine[i].token, symbol: mine[i].symbol })) }), true;
  }
  if (path === '/api/logo' && req.method === 'POST') {
    if (limited('logo', ip, 12)) return send(res, 429, { error: 'Too many pictures, try again in a minute' }), true;
    const b = await json(req, 2.5e6);
    const mm = String(b.png || '').match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/);
    if (!mm) return send(res, 400, { error: 'Bad picture' }), true;
    const img = Buffer.from(mm[2], 'base64');
    const isPng = img[1] === 0x50 && img[2] === 0x4e, isJpg = img[0] === 0xff && img[1] === 0xd8;
    if (img.length > 1.8e6 || !(isPng || isJpg)) return send(res, 400, { error: 'Bad picture' }), true;
    try { return send(res, 200, { logo: await pinLogo(img, String(b.name || ''), String(b.symbol || ''), isPng ? 'png' : 'jpg') }), true; }
    catch (e) { console.warn('logo:', e.message); return send(res, 502, { error: 'Could not pin the token picture. Try again.' }), true; }
  }
  if (path === '/api/rpc' && req.method === 'POST') {
    if (limited('rpc', ip, 300)) return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limited' } }), true;
    const one = JSON.parse((await body(req, 2e5)).toString() || '{}');
    const list = Array.isArray(one) ? one : [one];
    if (list.length > 10 || list.some((r) => !RPC_OK.has(r?.method))) return send(res, 400, { jsonrpc: '2.0', id: list[0]?.id ?? null, error: { code: -32601, message: 'method not allowed' } }), true;
    const out = await Promise.all(list.map((r) => P.rpcRaw({ jsonrpc: '2.0', id: r.id ?? 1, method: r.method, params: r.params ?? [] })));
    return send(res, 200, Array.isArray(one) ? out : out[0]), true;
  }
  return false;
}
