// Pons v2 on Robinhood Chain: everything HubGPU reads from the chain.
//
// Launch list <- Blockscout logs of the factory (TokenLaunched); the public RPC
//               mirrors refuse eth_getLogs over useful ranges.
// Prices      <- getReserves()/graduated() on each curve through Multicall3.
// Graduated   <- DexScreener (the curve is empty once the Uniswap pool takes over).
// Addresses and ABIs are the ones used by real launches on Robinhood Chain mainnet.
import { Interface, getAddress } from 'ethers';
import { getJson, postJson } from './net.js';

export const PONS = {
  chainId: 4663,
  explorer: 'https://robinhoodchain.blockscout.com',
  launchpad: 'https://www.ponsfamily.com/launchpad',
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  router: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  supply: 1_000_000_000,
  phantomEth: 1.68,
  graduationEth: 4.2,
};
export const NATIVE = '0x0000000000000000000000000000000000000000';
// The official RPC is TLS-intercepted on some Indonesian ISPs; mirrors first.
export const RPCS = process.env.RPC_URL ? [process.env.RPC_URL] : ['https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org', 'https://rpc.mainnet.chain.robinhood.com'];

const TOKEN_PARAMS = 'tuple(string name,string symbol,string logo,string description,tuple(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)';
export const factoryI = new Interface([
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function approvedPairTokens(address) view returns (bool)',
  'function launchForwarder() view returns (address)',
  'function getLaunchConfig(uint256 id) view returns (tuple(uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))',
  'function pairTokenEconomics(address) view returns (uint256 phantomQuote,uint256 graduationThreshold,uint8 decimals)',
  'function previewLaunchEconomics(uint256 launchConfigId,address pairToken) view returns (bytes32)',
  `function launchToken(${TOKEN_PARAMS} params,uint256 launchConfigId,address pairToken,address[] snipeTaxExemptions) payable returns (address token,address curve)`,
  'event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)',
  'function getLaunchedToken(address token) view returns (tuple(address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
]);
export const routerI = new Interface([
  `function launchAndBuy(${TOKEN_PARAMS} params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)`,
  'event Launched(address indexed token,address indexed curve,address indexed recipient,address launcher,uint256 quoteSpent,uint256 tokensReceived)',
]);
export const curveI = new Interface([
  'function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)',
  'function graduated() view returns (bool)',
  'function pairToken() view returns (address)',
  'function buybackEnabled() view returns (bool)',
  'function phantomQuote() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256 quoteOut)',
  'event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)',
  'event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)',
]);
export const tokenI = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function logo() view returns (string)',
  'function description() view returns (string)',
  'function socials() view returns (string twitter,string telegram,string discord,string website,string farcaster)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);
export const escrowI = new Interface(['function balanceOf(address recipient) view returns (uint256)', 'function balanceOfToken(address recipient,address token) view returns (uint256)']);
const quoterI = new Interface(['function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)']);
export const UNI = { quoter: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7', router: '0xCaf681a66D020601342297493863E78C959E5cb2', weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' };
const mcI = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);

const T_LAUNCHED = factoryI.getEvent('TokenLaunched').topicHash;
const T_BUY = curveI.getEvent('CurveBuy').topicHash;
const T_SELL = curveI.getEvent('CurveSell').topicHash;

// ---------- JSON-RPC with failover ----------
let rpcIdx = 0;
export async function rpc(method, params, timeoutS = 12) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try {
      const r = await postJson(url, { jsonrpc: '2.0', id: 1, method, params }, timeoutS);
      if (r.error) { const e = new Error(r.error.message); e.rpc = r.error; if (method === 'eth_call' || method === 'eth_estimateGas') throw Object.assign(e, { final: true }); throw e; }
      rpcIdx = (rpcIdx + i) % RPCS.length;
      return r.result;
    } catch (e) { lastErr = e; if (e.final) throw e; }
  }
  throw lastErr;
}
export const ethCall = (to, data, gas) => rpc('eth_call', [gas ? { to, data, gas } : { to, data }, 'latest']);

/** Pass one JSON-RPC request through the mirrors untouched (errors included). */
export async function rpcRaw(payload) {
  let lastErr;
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rpcIdx + i) % RPCS.length];
    try { const r = await postJson(url, payload, 20); rpcIdx = (rpcIdx + i) % RPCS.length; return r; } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function multicall(calls, { size = 200, gas } = {}) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) {
    const chunk = calls.slice(i, i + size);
    const data = mcI.encodeFunctionData('aggregate3', [chunk.map(c => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
    const [res] = mcI.decodeFunctionResult('aggregate3', await ethCall(PONS.multicall3, data, gas));
    res.forEach((r, j) => {
      if (!r.success || r.returnData === '0x') return out.push(null);
      try { out.push(chunk[j].iface.decodeFunctionResult(chunk[j].fn, r.returnData)); } catch { out.push(null); }
    });
  }
  return out;
}

// ---------- launch terms (read live before every launch, per pair) ----------
const termsCache = new Map();
export async function terms(pair = NATIVE) {
  pair = pair.toLowerCase();
  const hit = termsCache.get(pair);
  if (hit && hit.until > Date.now()) return hit.data;
  const r = await multicall([
    { target: PONS.factory, iface: factoryI, fn: 'launchFee' },
    { target: PONS.factory, iface: factoryI, fn: 'launchEnabled' },
    { target: PONS.factory, iface: factoryI, fn: 'previewLaunchEconomics', args: [0, pair] },
    { target: PONS.factory, iface: factoryI, fn: 'maxCreatorTaxBps' },
    { target: PONS.factory, iface: factoryI, fn: 'approvedPairTokens', args: [pair] },
    { target: PONS.factory, iface: factoryI, fn: 'pairTokenEconomics', args: [pair] },
    { target: PONS.factory, iface: factoryI, fn: 'launchForwarder' },
    { target: PONS.factory, iface: factoryI, fn: 'getLaunchConfig', args: [0] },
  ]);
  if (!r[0] || !r[2]) throw new Error('Could not read Pons launch terms');
  const native = pair === NATIVE;
  const econ = r[5] && !native ? { phantom: r[5][0].toString(), threshold: r[5][1].toString(), decimals: Number(r[5][2]) } : { phantom: String(BigInt(Math.round(PONS.phantomEth * 1e6)) * 10n ** 12n), threshold: String(BigInt(Math.round(PONS.graduationEth * 1e6)) * 10n ** 12n), decimals: 18 };
  // proven on mainnet: launch-and-buy goes to the factory's live launchForwarder
  const fwd = r[6]?.[0] && r[6][0] !== NATIVE ? getAddress(r[6][0]) : PONS.router;
  const data = {
    factory: PONS.factory, router: fwd, feeEscrow: PONS.feeEscrow, configId: 0, pair,
    launchFeeWei: r[0][0].toString(), enabled: !!r[1]?.[0] && r[7]?.[0]?.enabled !== false, economics: r[2][0],
    maxCreatorTaxBps: Number(r[3]?.[0] ?? 0), approved: native || !!r[4]?.[0], econ,
  };
  termsCache.set(pair, { data, until: Date.now() + 60_000 });
  return data;
}

// ---------- ETH -> pair routes (Uniswap v3), for buying pair coins with ETH ----------
const encPath = (...parts) => '0x' + parts.map(x => typeof x === 'number' ? x.toString(16).padStart(6, '0') : x.replace(/^0x/, '').toLowerCase()).join('');
const routeCache = new Map();
/** best ETH -> pair path by QuoterV2 (1 hop via WETH, or 2 hops via USDG); out = pair units for 0.01 ETH */
export async function route(pair) {
  pair = pair.toLowerCase();
  const hit = routeCache.get(pair);
  if (hit && hit.until > Date.now()) return hit.data;
  const PROBE = 10n ** 16n;
  const cands = [];
  for (const f of [100, 500, 3000, 10000]) cands.push({ path: encPath(UNI.weth, f, pair), hops: 1 });
  if (pair !== UNI.usdg.toLowerCase()) for (const f1 of [500, 3000]) for (const f2 of [100, 500, 3000, 10000]) cands.push({ path: encPath(UNI.weth, f1, UNI.usdg, f2, pair), hops: 2 });
  const res = await multicall(cands.map(c => ({ target: UNI.quoter, iface: quoterI, fn: 'quoteExactInput', args: [c.path, PROBE] })), { size: 6, gas: '0x2faf080' });
  let best = null;
  res.forEach((r, i) => {
    if (!r) return;
    const out = r[0], score = cands[i].hops === 2 ? out * 997n / 1000n : out;
    if (out > 0n && (!best || score > best.score)) best = { ...cands[i], out: out.toString(), score };
  });
  if (best) delete best.score;
  routeCache.set(pair, { data: best, until: Date.now() + 10 * 60_000 });
  return best;
}
export async function quoteRoute(path, wei) {
  const [r] = await multicall([{ target: UNI.quoter, iface: quoterI, fn: 'quoteExactInput', args: [path, BigInt(wei)] }], { gas: '0x2faf080' });
  if (!r) throw new Error('No ETH route for this pair right now');
  return r[0].toString();
}
/** USD price of one pair token (ETH = ethUsd, USDG = 1, others from the ETH route) */
export async function pairUsd(pair, decimals, ethUsd) {
  pair = pair.toLowerCase();
  if (pair === NATIVE) return ethUsd;
  if (pair === UNI.usdg.toLowerCase()) return 1;
  const r = await route(pair).catch(() => null);
  if (!r) return 0;
  const perEth = Number(r.out) / 10 ** decimals / 0.01;
  return perEth > 0 ? ethUsd / perEth : 0;
}

// ---------- one coin, any pair ----------
/** Full live state of a Pons coin (ETH or token paired). Amounts in pair units. */
export async function coinState(token) {
  const [r] = await multicall([{ target: PONS.factory, iface: factoryI, fn: 'getLaunchedToken', args: [token] }]);
  const x = r?.[0];
  if (!x || !x.exists) return null;
  const curve = getAddress(x.curve), pair = x.pairToken.toLowerCase();
  const calls = [
    { target: curve, iface: curveI, fn: 'getReserves' }, { target: curve, iface: curveI, fn: 'graduated' },
    { target: curve, iface: curveI, fn: 'phantomQuote' }, { target: curve, iface: curveI, fn: 'graduationThreshold' },
  ];
  if (pair !== NATIVE) calls.push({ target: pair, iface: tokenI, fn: 'decimals' }, { target: pair, iface: tokenI, fn: 'symbol' });
  const m = await multicall(calls);
  const dec = pair === NATIVE ? 18 : Number(m[4]?.[0] ?? 18);
  const q = m[0] ? Number(m[0][0]) / 10 ** dec : 0, tk = m[0] ? Number(m[0][1]) / 1e18 : 0;
  const phantom = m[2] ? Number(m[2][0]) / 10 ** dec : (pair === NATIVE ? PONS.phantomEth : 0);
  const threshold = m[3] ? Number(m[3][0]) / 10 ** dec : (pair === NATIVE ? PONS.graduationEth : 0);
  const raised = Math.max(0, q - phantom);
  return {
    token: getAddress(x.token), curve, deployer: getAddress(x.deployer), feeTo: getAddress(x.creatorFeeRecipient),
    pair, pairSymbol: pair === NATIVE ? 'ETH' : String(m[5]?.[0] ?? 'TOKEN'), pairDecimals: dec,
    taxBps: Number(x.creatorTaxBps), buyback: !!x.buybackEnabled, grad: !!m[1]?.[0],
    priceQ: tk > 0 ? q / tk : 0, raised, threshold, progress: threshold ? Math.min(1, raised / threshold) : 0,
  };
}

// ---------- launches ----------
const addrTopic = t => getAddress('0x' + t.slice(26));
const bsUrl = path => `${PONS.explorer}/api/v2/${path}`;
const bs = path => getJson(bsUrl(path), PONS.explorer + '/');

/** TokenLaunched logs newest-first until a known block (first run walks back maxPages × 50). */
export async function fetchNewLaunches(knownTopBlock, maxPages) {
  const found = [];
  let params = '';
  for (let page = 0; page < maxPages; page++) {
    const j = await bs(`addresses/${PONS.factory}/logs${params}`);
    let reached = false;
    for (const it of j.items ?? []) {
      if (it.block_number <= knownTopBlock) { reached = true; continue; }
      if (it.topics?.[0] !== T_LAUNCHED) continue;
      found.push({
        token: addrTopic(it.topics[1]), curve: addrTopic(it.topics[2]), deployer: addrTopic(it.topics[3]),
        block: it.block_number, t: Date.parse(it.block_timestamp), tx: it.transaction_hash,
        pair: ('0x' + (it.data ?? '').slice(26, 66)).toLowerCase(),
      });
    }
    found.next = reached ? null : j.next_page_params || null;
    if (reached || !j.next_page_params) break;
    params = '?' + new URLSearchParams(j.next_page_params).toString();
  }
  return found;
}

export async function fetchMeta(list) {
  const fns = ['name', 'symbol', 'logo', 'description', 'socials'];
  const res = await multicall(list.flatMap(l => fns.map(fn => ({ target: l.token, iface: tokenI, fn }))));
  list.forEach((l, i) => {
    const r = k => res[i * fns.length + k];
    l.name = String(r(0)?.[0] ?? '').slice(0, 64);
    l.symbol = String(r(1)?.[0] ?? '').slice(0, 16);
    l.logo = String(r(2)?.[0] ?? '').slice(0, 512);
    l.desc = String(r(3)?.[0] ?? '').slice(0, 600);
    const s = r(4);
    l.x = s?.twitter ?? ''; l.tg = s?.telegram ?? ''; l.site = s?.website ?? ''; l.fcUrl = s?.farcaster ?? '';
  });
  return list;
}

/** Re-price ETH-paired curves in place. */
export async function priceCurves(list, ethUsd) {
  const res = await multicall(list.flatMap(t => [{ target: t.curve, iface: curveI, fn: 'getReserves' }, { target: t.curve, iface: curveI, fn: 'graduated' }]));
  const now = Date.now();
  list.forEach((t, i) => {
    const rv = res[i * 2], grad = !!res[i * 2 + 1]?.[0];
    if (grad && !t.grad) t.gradAt = now;
    t.grad = grad;
    if (!rv || grad) return;
    const q = Number(rv[0]) / 1e18, tk = Number(rv[1]) / 1e18;
    if (!(tk > 0)) return;
    t.raised = Math.max(0, q - PONS.phantomEth);
    t.progress = Math.min(1, t.raised / PONS.graduationEth);
    t.priceEth = q / tk;
    t.mcap = t.priceEth * PONS.supply * ethUsd;
    (t.hist ||= []).push([now, Math.round(t.mcap)]);
    const cut = now - 26 * 3600e3;
    while (t.hist.length && t.hist[0][0] < cut) t.hist.shift();
    if (t.hist.length > 400) t.hist.splice(0, t.hist.length - 400);
  });
}

export async function priceGraduated(list) {
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    try {
      const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/robinhood/${chunk.map(t => t.token).join(',')}`);
      for (const t of chunk) {
        const best = (pairs || []).filter(p => p.baseToken?.address?.toLowerCase() === t.token.toLowerCase()).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        if (!best) continue;
        t.mcap = best.marketCap ?? best.fdv ?? t.mcap;
        t.ch1h = best.priceChange?.h1 ?? t.ch1h;
        t.ch24 = best.priceChange?.h24 ?? t.ch24;
        t.vol24 = best.volume?.h24 ?? t.vol24;
        t.dex = best.url;
        t.progress = 1;
      }
    } catch {}
  }
}

// ---------- per-coin detail ----------
// Local fork runs (content capture, tests against anvil): the explorer does not know fork-only blocks, so the curve's
// logs are read straight from the RPC instead. Only when HUB_LOGS_RPC=1 (never set on the live server).
const blockTimes = new Map();
async function tradePageRpc(curve, decimals) {
  const logs = await rpc('eth_getLogs', [{ address: curve, fromBlock: '0x' + Number(process.env.HUB_LOGS_FROM || 0).toString(16), toBlock: 'latest', topics: [[T_BUY, T_SELL]] }], 30);
  const items = [];
  for (const it of logs || []) {
    const bn = it.blockNumber;
    if (!blockTimes.has(bn)) { const blk = await rpc('eth_getBlockByNumber', [bn, false]); blockTimes.set(bn, Number(blk.timestamp) * 1000); }
    try {
      const ev = curveI.parseLog({ topics: it.topics, data: it.data });
      const buy = it.topics[0] === T_BUY;
      const eth = Number(buy ? ev.args.quoteIn : ev.args.quoteOut) / 10 ** decimals;
      const tokens = Number(buy ? ev.args.tokensOut : ev.args.tokensIn) / 1e18;
      items.push({ key: it.transactionHash + ':' + Number(it.logIndex), side: buy ? 'buy' : 'sell', who: buy ? ev.args.recipient : ev.args.seller, eth, tokens, priceEth: tokens > 0 ? eth / tokens : 0, t: blockTimes.get(bn), tx: it.transactionHash, bn: Number(bn), li: Number(it.logIndex) });
    } catch {}
  }
  items.sort((a, b) => b.bn - a.bn || b.li - a.li);
  return { items: items.map(({ bn, li, ...t }) => t), next: '' };
}

/** One page of buys and sells on a curve, newest first: { items, next } (next: the query for the older page, or ''). */
export async function tradePage(curve, params = '', decimals = 18) {
  if (process.env.HUB_LOGS_RPC === '1') return params ? { items: [], next: '' } : tradePageRpc(curve, decimals);
  const j = await bs(`addresses/${curve}/logs${params}`);
  const items = [];
  for (const it of j.items ?? []) {
    const t0 = it.topics?.[0];
    if (t0 !== T_BUY && t0 !== T_SELL) continue;
    try {
      const ev = curveI.parseLog({ topics: it.topics.filter(Boolean), data: it.data });
      const buy = t0 === T_BUY;
      const eth = Number(buy ? ev.args.quoteIn : ev.args.quoteOut) / 10 ** decimals;
      const tokens = Number(buy ? ev.args.tokensOut : ev.args.tokensIn) / 1e18;
      items.push({ key: it.transaction_hash + ':' + it.index, side: buy ? 'buy' : 'sell', who: buy ? ev.args.recipient : ev.args.seller, eth, tokens, priceEth: tokens > 0 ? eth / tokens : 0, t: Date.parse(it.block_timestamp), tx: it.transaction_hash });
    } catch {}
  }
  return { items, next: j.next_page_params ? '?' + new URLSearchParams(j.next_page_params).toString() : '' };
}

/** Buys and sells on a curve, newest first (up to `pages` × 50 logs). */
export async function trades(curve, pages = 2, decimals = 18) {
  const out = [];
  let params = '';
  for (let p = 0; p < pages; p++) {
    const pg = await tradePage(curve, params, decimals);
    out.push(...pg.items);
    if (!pg.next) break;
    params = pg.next;
  }
  return out;
}

export async function holders(token) {
  const [j, c] = await Promise.all([bs(`tokens/${token}/holders`), bs(`tokens/${token}/counters`).catch(() => ({}))]);
  const total = PONS.supply;
  return {
    count: Number(c.token_holders_count || 0),
    top: (j.items || []).slice(0, 20).map(h => ({ addr: getAddress(h.address.hash), contract: !!h.address.is_contract, name: h.address.name || '', pct: Number(h.value) / 1e18 / total * 100 })),
  };
}

/** A launch tx: confirm it hit the Pons factory and return what it made. */
export async function readLaunchTx(hash) {
  const rc = await rpc('eth_getTransactionReceipt', [hash]);
  if (!rc) return null;
  if (rc.status !== '0x1') throw new Error('Launch transaction failed on-chain');
  const lg = rc.logs.find(l => l.address.toLowerCase() === PONS.factory.toLowerCase() && l.topics[0] === T_LAUNCHED);
  if (!lg) throw new Error('Not a Pons launch');
  const blk = await rpc('eth_getBlockByNumber', [rc.blockNumber, false]);
  return {
    token: addrTopic(lg.topics[1]), curve: addrTopic(lg.topics[2]), deployer: addrTopic(lg.topics[3]),
    block: Number(rc.blockNumber), t: Number(blk?.timestamp || 0) * 1000 || Date.now(), tx: hash, from: getAddress(rc.from),
    pair: ('0x' + lg.data.slice(26, 66)).toLowerCase(),
  };
}

/** Claimable creator fees for a wallet: escrow balance + fees still sitting on its curves. */
export async function feesFor(addr, curves) {
  const calls = [{ target: PONS.feeEscrow, iface: escrowI, fn: 'balanceOf', args: [addr] }];
  for (const c of curves) calls.push({ target: c, iface: curveI, fn: 'quoteFeeBalance' }, { target: c, iface: curveI, fn: 'creatorTaxBalance' }, { target: c, iface: curveI, fn: 'buybackEnabled' });
  const r = await multicall(calls);
  const escrow = r[0]?.[0] ?? 0n;
  const onCurves = curves.map((c, i) => ({ curve: c, fee: r[1 + i * 3]?.[0] ?? 0n, tax: r[2 + i * 3]?.[0] ?? 0n, buyback: !!r[3 + i * 3]?.[0] }));
  return { escrowWei: escrow.toString(), curves: onCurves.map(x => ({ curve: x.curve, feeWei: x.fee.toString(), taxWei: x.tax.toString(), buyback: x.buyback })) };
}

export async function ethUsd(prev) {
  for (const [url, pick] of [
    ['https://data-api.binance.vision/api/v3/ticker/price?symbol=ETHUSDT', j => Number(j.price)],
    ['https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', j => Number(j.ethereum.usd)],
  ]) {
    try { const v = pick(await getJson(url)); if (v > 100) return v; } catch {}
  }
  return prev || 0;
}

/** Any Pons coin by address (for coins older than the indexed window). */
export async function lookupToken(token) {
  const [r] = await multicall([{ target: PONS.factory, iface: factoryI, fn: 'getLaunchedToken', args: [token] }]);
  const x = r?.[0];
  if (!x || !x.exists) return null;
  return { token: getAddress(x.token), curve: getAddress(x.curve), deployer: getAddress(x.deployer), feeTo: getAddress(x.creatorFeeRecipient), pair: x.pairToken.toLowerCase(), t: 0, block: 0 };
}
export { multicall };

/**
 * Creator fees for a wallet, per pair asset. Pons keeps ETH fees and token fees apart in its
 * escrow (balanceOf / balanceOfToken), and each curve holds fees in its own pair until swept.
 * coins: [{ curve, pair }] → [{ pair, escrowWei, curves: [{ curve, feeWei, taxWei, buyback }] }]
 */
export async function feesByPair(addr, coins) {
  const pairs = [...new Set([NATIVE, ...coins.map(c => c.pair.toLowerCase())])];
  const calls = pairs.map(p => p === NATIVE
    ? { target: PONS.feeEscrow, iface: escrowI, fn: 'balanceOf', args: [addr] }
    : { target: PONS.feeEscrow, iface: escrowI, fn: 'balanceOfToken', args: [addr, p] });
  for (const c of coins) calls.push({ target: c.curve, iface: curveI, fn: 'quoteFeeBalance' }, { target: c.curve, iface: curveI, fn: 'creatorTaxBalance' }, { target: c.curve, iface: curveI, fn: 'buybackEnabled' });
  const r = await multicall(calls);
  const out = pairs.map((p, i) => ({ pair: p, escrowWei: (r[i]?.[0] ?? 0n).toString(), curves: [] }));
  coins.forEach((c, i) => {
    const k = pairs.length + i * 3;
    out[pairs.indexOf(c.pair.toLowerCase())].curves.push({ curve: c.curve, feeWei: (r[k]?.[0] ?? 0n).toString(), taxWei: (r[k + 1]?.[0] ?? 0n).toString(), buyback: !!r[k + 2]?.[0] });
  });
  return out;
}
