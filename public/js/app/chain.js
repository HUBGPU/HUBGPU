// HubGPU on-chain: launch a measured token on Pons (always with the creator's first buy), buy and sell on its curve.
// Reads go through our read-only /api/rpc; every write is signed in the visitor's wallet. The calls are the ones
// proven on Robinhood Chain mainnet: launchAndBuy through the factory's live launch forwarder, and the curve's
// own buy/sell.
import { BrowserProvider, JsonRpcProvider, Interface, hexlify, randomBytes, MaxUint256, ZeroAddress, parseEther, formatEther } from "/vendor/ethers.min.js";
import { wallet, connect, ensureChain } from "./wallet.js";

const CFG = window.HUBGPU_CONFIG;
export const read = new JsonRpcProvider(location.origin + "/api/rpc", { chainId: CFG.chain.id, name: "robinhood" }, { staticNetwork: true, batchMaxCount: 1 });
const BPS = 10000n;
const TOKEN_PARAMS = "tuple(string name,string symbol,string logo,string description,tuple(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)";
const ERRORS = ["error LaunchFeeNotPaid()", "error NotWhitelisted()", "error LaunchEconomicsMismatch(bytes32 expected,bytes32 actual)", "error CreatorTaxTooHigh()", "error InvalidTokenParams()", "error LaunchConfigDisabled()", "error CurveGraduated()", "error SlippageExceeded(uint256 actual,uint256 minimum)", "error ZeroAmount()", "error NativeValueMismatch(uint256 supplied,uint256 expected)", "error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)", "error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)"];
const factoryI = new Interface(["event TokenLaunched(address indexed token,address indexed curve,address indexed deployer,address pairToken,uint256 launchConfigId,uint256 graduationThreshold)", ...ERRORS]);
const routerI = new Interface([`function launchAndBuy(${TOKEN_PARAMS} params,uint256 launchConfigId,address pairToken,uint256 quoteIn,uint256 minTokensOut,address recipient,address[] snipeTaxExemptions) payable returns (address token,address curve,uint256 tokensOut)`, ...ERRORS]);
const curveI = new Interface([
  "function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)", "function graduated() view returns (bool)", "function feeBps() view returns (uint256)", "function creatorTaxBps() view returns (uint256)",
  "function sellableTokens() view returns (uint256)", "function currentSnipeTaxBps(address recipient) view returns (uint256)",
  "function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)", "function sell(uint256 tokensIn,uint256 minQuoteOut,address recipient) returns (uint256 quoteOut)", ...ERRORS]);
const LP_ARGS = "tuple(string name,string symbol,string logo,string description,string twitter,string telegram,string website,string bits,bytes32 salt,bytes32 expectedEconomics,uint256 minTokensOut,uint16 creatorTaxBps)";
const lpI = new Interface([
  `function launch(${LP_ARGS} a) payable returns (address token,address curve,uint256 tokensOut)`,
  "function terms(address wallet) view returns (uint256 fee,uint256 ponsFee,uint256 minBuy,bool holder,bool isPaused)",
  "event TokenBorn(address indexed token,address indexed creator,address curve,string bits,bool rare,uint256 feePaid,uint256 firstBuy,uint256 tokensOut,uint16 creatorTaxBps)",
  "error LaunchesPaused()", "error BadBits()", "error RareNeedsHolder()", "error FirstBuyRequired()", "error BadValue()", "error Reentrant()", "error TransferFailed()", ...ERRORS]);
const LAUNCHPAD = /^0x[0-9a-fA-F]{40}$/.test(CFG.launchpad?.address || "") ? CFG.launchpad.address : "";
/** HubGPU's launch fee for a wallet, from the contract ({ fee, holder } in ETH; zero when no contract is set) */
export async function hubTerms(who) {
  if (!LAUNCHPAD) return { fee: 0, holder: false, contract: false };
  const r = await call(LAUNCHPAD, lpI, "terms", [who || ZeroAddress]);
  return { fee: Number(r.fee) / 1e18, feeWei: r.fee, ponsFeeWei: r.ponsFee, minBuyWei: r.minBuy, holder: r.holder, paused: r.isPaused, contract: true };
}
const erc20I = new Interface(["function balanceOf(address owner) view returns (uint256)", "function allowance(address owner,address spender) view returns (uint256)", "function approve(address spender,uint256 amount) returns (bool)", ...ERRORS]);
export const txUrl = (h) => `${CFG.chain.explorer}/tx/${h}`;
export { parseEther, formatEther };

const api = async (path, opts) => {
  const r = await fetch("/api" + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Request failed");
  return j;
};
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Wallet and Pons errors in plain words. */
export function why(e) {
  const raw = e?.info?.error?.message || e?.error?.message || e?.shortMessage || e?.message || String(e);
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || /user (rejected|denied)|rejected the request/i.test(raw)) return "You cancelled in the wallet.";
  if (e?.need) return `Not enough ETH on ${CFG.chain.label}. You need about ${(+formatEther(e.need)).toFixed(5)} ETH, the wallet has ${(+formatEther(e.bal)).toFixed(5)}.`;
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    for (const i of [lpI, factoryI, curveI, erc20I]) {
      try {
        const p = i.parseError(data);
        if (p) return ({
          LaunchFeeNotPaid: "The launch fee changed. Try again.", LaunchEconomicsMismatch: "Pons updated its launch terms. Try again.",
          CreatorTaxTooHigh: "That creator tax is above what Pons allows.", InvalidTokenParams: "Pons rejected the name, ticker or picture. Try a shorter name or ticker.",
          LaunchConfigDisabled: "Pons has launches paused right now.", CurveGraduated: "This token graduated. Trade it on Pons.",
          SlippageExceeded: "The price moved. Try again.", ZeroAmount: "Enter an amount.",
          ERC20InsufficientBalance: "You don't hold that much.", ERC20InsufficientAllowance: "The approval did not go through. Try again.",
          LaunchesPaused: "Launches are paused for a moment. Try again soon.", BadBits: "The birth record is not valid. Measure again.",
          RareNeedsHolder: "A 16-qubit birth needs enough $HGPU in this wallet.", FirstBuyRequired: "The first buy is too small.",
        })[p.name] || p.name;
      } catch { /* not this interface */ }
    }
  }
  if (/insufficient funds/i.test(raw)) return `Not enough ETH on ${CFG.chain.label} for this and the network fee.`;
  return raw.replace(/\(action=.*$/, "").slice(0, 170);
}

async function signer() {
  if (!wallet.address) await connect();
  await ensureChain();
  return new BrowserProvider(wallet.provider).getSigner();
}
async function send(sg, tx, label, onStep) {
  let gas;
  try { gas = await read.estimateGas({ from: wallet.address, ...tx }); }
  catch (e) { const w = why(e); throw new Error(/Not enough ETH/i.test(w) ? w : `${label} would fail: ${w} Nothing was sent.`); }
  onStep?.(`Confirm “${label}” in your wallet…`);
  const r = await sg.sendTransaction({ ...tx, gasLimit: (gas * 130n) / 100n });
  onStep?.(`${label}: waiting for ${CFG.chain.label}…`, r.hash);
  const rc = await read.waitForTransaction(r.hash, 1, 180_000);
  if (!rc || rc.status !== 1) throw new Error(label + " failed on-chain.");
  return rc;
}
const call = async (to, iface, fn, args = [], from) => iface.decodeFunctionResult(fn, await read.call({ to, data: iface.encodeFunctionData(fn, args), ...(from ? { from } : {}) }));

/* ── launch ─────────────────────────────────────────────── */
export function xUrl(v) {
  v = String(v || "").trim();
  if (!v) return "";
  const m = v.match(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?$/i) || v.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? "https://x.com/" + m[1] : "";
}
/** '@group', 't.me/group', 'https://t.me/group' → https://t.me/group ('' when empty or not a handle) */
export function tgUrl(v) {
  v = String(v || "").trim();
  if (!v) return "";
  const m = v.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z0-9_+]{3,64})\/?$/i) || v.match(/^@?([A-Za-z0-9_]{4,32})$/);
  return m ? "https://t.me/" + m[1] : "";
}
/** the wallet's ETH on Robinhood Chain, and what a launch costs in gas right now (about 4.5 M gas) */
export const ethBalance = (who) => read.getBalance(who);
export async function networkFeeWei() { const g = (await read.getFeeData()).gasPrice || 10_000_000n; return g * 4_500_000n; }
const C = CFG.launch.curve;
/** % of supply a first buy of `eth` gets on a fresh curve (fee and tax taken first). */
export function firstBuyShare(eth, taxPct = 0) {
  const net = eth * (1 - C.feeBps / 1e4 - taxPct / 100);
  return net > 0 ? (net / (C.phantomEth + net)) * 100 : 0;
}
export const terms = () => api("/terms");

/**
 * f: { name, symbol, description, twitter, taxPct, buyEth, png, bits, p, gpu }
 * onStep(text, hash?) → { hash, token, curve, row }
 */
export async function launchToken(f, onStep = () => {}) {
  const buyEth = Number(f.buyEth);
  if (!(buyEth >= CFG.launch.minBuyEth)) throw new Error(`The first buy is required: at least ${CFG.launch.minBuyEth} ETH.`);
  const sg = await signer();
  const me = wallet.address;
  onStep("Reading the Pons launch terms…");
  const t = await terms();
  if (!t.enabled) throw new Error("Pons has launches paused right now.");
  const taxBps = Math.round(Math.max(0, Math.min(Number(f.taxPct) || 0, 10)) * 100);
  if (taxBps > t.maxCreatorTaxBps) throw new Error(`Creator tax can be at most ${t.maxCreatorTaxBps / 100}%.`);
  const hub = LAUNCHPAD ? await hubTerms(me) : null;
  if (hub?.paused) throw new Error("Launches are paused for a moment. Try again soon.");
  if (f.bits.length > 12 && hub && !hub.holder) throw new Error("A 16-qubit birth needs enough $HGPU in this wallet.");
  const fee = BigInt(t.launchFeeWei), hubFee = hub ? hub.feeWei : 0n, buyIn = parseEther(String(buyEth));
  const gasPrice = (await read.getFeeData()).gasPrice || 10_000_000n;
  const need = fee + hubFee + buyIn + gasPrice * 6_000_000n;
  const bal = await read.getBalance(me);
  if (bal < need) throw Object.assign(new Error("need"), { need, bal });
  onStep("Pinning the seal your GPU drew…");
  const { logo } = await post("/logo", { png: f.png, name: f.name, symbol: f.symbol });

  // Pons counts the description in bytes (max 2048); the birth tag and bitstring always stay at the end
  const tag = `\n\n${CFG.launch.tag} · |${f.bits}⟩`;
  let desc = String(f.description || "").trim();
  while (new TextEncoder().encode(desc + tag).length > 2000) desc = desc.slice(0, -1);
  // the token's website is its own HubGPU page: /born/<id> resolves to /t/<CA> once the launch is read back
  const salt = hexlify(randomBytes(32));
  const site = `https://${CFG.domain || location.host}/born/${salt.slice(2, 18)}`;
  const params = {
    name: String(f.name).trim().slice(0, 64), symbol: String(f.symbol).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16), logo,
    description: desc + tag,
    socials: { twitter: xUrl(f.twitter), telegram: tgUrl(f.telegram), discord: "", website: site, farcaster: "" },
    creatorFeeRecipient: me, creatorTaxBps: taxBps, buybackEnabled: false, expectedEconomics: t.economics, salt,
  };
  if (LAUNCHPAD) return launchViaContract(f, params, { fee, hubFee, buyIn, sg, me, desc }, onStep);
  onStep("Simulating the launch. A refusal here costs nothing…");
  const to = t.router, value = fee + buyIn;
  let sim;
  try { sim = routerI.decodeFunctionResult("launchAndBuy", await read.call({ from: me, to, value, data: routerI.encodeFunctionData("launchAndBuy", [params, 0, ZeroAddress, buyIn, 0n, me, []]) })); }
  catch (e) { throw new Error("The launch fails when simulated: " + why(e) + " Nothing was sent."); }
  const data = routerI.encodeFunctionData("launchAndBuy", [params, 0, ZeroAddress, buyIn, (sim.tokensOut * 90n) / 100n, me, []]);
  const rc = await send(sg, { to, data, value }, `Launch $${params.symbol}`, onStep);
  const log = rc.logs.map((l) => { try { return factoryI.parseLog(l); } catch { return null; } }).find((x) => x?.name === "TokenLaunched");
  onStep("Adding it to the HubGPU launchpad…", rc.hash);
  let row = null;
  for (let i = 0; i < 3 && !row; i++) {
    try { row = await post("/launches", { tx: rc.hash, p: f.p, gpu: f.gpu }); }
    catch (e) { if (i === 2) console.warn(e); await new Promise((r) => setTimeout(r, 2000)); }
  }
  return { hash: rc.hash, token: log?.args?.token, curve: log?.args?.curve, row };
}

/** the same launch through the HubGPU launchpad contract: it writes the birth record, takes the fee, waives it for holders */
async function launchViaContract(f, params, { fee, hubFee, buyIn, sg, me, desc }, onStep) {
  const a = {
    name: params.name, symbol: params.symbol, logo: params.logo, description: desc, twitter: params.socials.twitter, telegram: params.socials.telegram, website: params.socials.website,
    bits: f.bits, salt: params.salt, expectedEconomics: params.expectedEconomics, minTokensOut: 0n, creatorTaxBps: params.creatorTaxBps,
  };
  const value = fee + hubFee + buyIn;
  onStep("Simulating the launch. A refusal here costs nothing…");
  let sim;
  try { sim = lpI.decodeFunctionResult("launch", await read.call({ from: me, to: LAUNCHPAD, value, data: lpI.encodeFunctionData("launch", [a]) })); }
  catch (e) { throw new Error("The launch fails when simulated: " + why(e) + " Nothing was sent."); }
  a.minTokensOut = (sim.tokensOut * 90n) / 100n;
  const rc = await send(sg, { to: LAUNCHPAD, data: lpI.encodeFunctionData("launch", [a]), value }, `Launch $${params.symbol}`, onStep);
  const log = rc.logs.map((l) => { try { return l.address.toLowerCase() === LAUNCHPAD.toLowerCase() ? lpI.parseLog(l) : null; } catch { return null; } }).find((x) => x?.name === "TokenBorn");
  onStep("Adding it to the HubGPU launchpad…", rc.hash);
  let row = null;
  for (let i = 0; i < 3 && !row; i++) {
    try { row = await post("/launches", { tx: rc.hash, p: f.p, gpu: f.gpu }); }
    catch (e) { if (i === 2) console.warn(e); await new Promise((r) => setTimeout(r, 2000)); }
  }
  return { hash: rc.hash, token: log?.args?.token, curve: log?.args?.curve, row };
}

/* ── the curve: state, quotes, buy, sell (PonsV2BondingCurveMath, same as the contract) ── */
export async function curveState(coin) {
  const me = wallet.address || ZeroAddress, c = coin.curve;
  const [[qr, tr], [grad], [feeBps], [taxBps], [sellable], [snipe]] = await Promise.all([
    call(c, curveI, "getReserves"), call(c, curveI, "graduated"), call(c, curveI, "feeBps"), call(c, curveI, "creatorTaxBps"), call(c, curveI, "sellableTokens"), call(c, curveI, "currentSnipeTaxBps", [me]),
  ]);
  const st = { qr, tr, grad, feeBps, taxBps, sellable, snipeBps: snipe, eth: 0n, tok: 0n };
  if (wallet.address) [st.eth, [st.tok]] = await Promise.all([read.getBalance(me), call(coin.token, erc20I, "balanceOf", [me])]);
  return st;
}
const out = (a, rIn, rOut) => (a <= 0n ? 0n : (a * rOut) / (rIn + a));
export function quoteBuy(st, quoteIn) {
  let snipe = st.snipeBps;
  const max = BPS - st.feeBps - st.taxBps - 100n;
  if (snipe > max) snipe = max;
  const net = quoteIn - (quoteIn * (st.feeBps + st.taxBps + snipe)) / BPS;
  let t = out(net, st.qr, st.tr);
  if (t > st.sellable) t = st.sellable;
  return t;
}
export function quoteSell(st, tokensIn) {
  const g = out(tokensIn, st.tr, st.qr);
  return g - (g * (st.feeBps + st.taxBps)) / BPS;
}
export async function buy(coin, ethIn, onStep = () => {}, slipBps = 800n) {
  const sg = await signer(), me = wallet.address;
  const st = await curveState(coin);
  if (st.grad) throw new Error("This token graduated. Trade it on Pons.");
  if (st.eth < ethIn) throw Object.assign(new Error("need"), { need: ethIn, bal: st.eth });
  const minOut = (quoteBuy(st, ethIn) * (BPS - slipBps)) / BPS;
  return (await send(sg, { to: coin.curve, value: ethIn, data: curveI.encodeFunctionData("buy", [ethIn, minOut, me]) }, `Buy $${coin.symbol}`, onStep)).hash;
}
export async function sell(coin, tokensIn, onStep = () => {}, slipBps = 800n) {
  const sg = await signer(), me = wallet.address;
  const st = await curveState(coin);
  if (st.grad) throw new Error("This token graduated. Trade it on Pons.");
  if (tokensIn > st.tok) tokensIn = st.tok;
  if (tokensIn <= 0n) throw new Error("You don't hold any.");
  const [cur] = await call(coin.token, erc20I, "allowance", [me, coin.curve]);
  if (cur < tokensIn) await send(sg, { to: coin.token, data: erc20I.encodeFunctionData("approve", [coin.curve, MaxUint256]) }, `Allow selling $${coin.symbol}`, onStep);
  const minOut = (quoteSell(st, tokensIn) * (BPS - slipBps)) / BPS;
  return (await send(sg, { to: coin.curve, data: curveI.encodeFunctionData("sell", [tokensIn, minOut, me]) }, `Sell $${coin.symbol}`, onStep)).hash;
}

/* ── creator fees: sweep each curve into the Pons escrow, then claim (70% of the 1% fee + all of the tax) ── */
const escrowI = new Interface(["function claim() returns (uint256 amount)", "function balanceOf(address recipient) view returns (uint256)"]);
const sweepI = new Interface(["function sweepFees(uint256 minBuybackTokensOut)"]);
const curvePending = (x) => (x.buyback ? 0n : BigInt(x.feeWei) - (BigInt(x.feeWei) * 30n) / 100n + BigInt(x.taxWei));
export const pendingWei = (f) => BigInt(f?.escrowWei ?? 0) + (f?.curves ?? []).reduce((s, x) => s + curvePending(x), 0n);
export async function claimFees(f, onStep = () => {}) {
  const sg = await signer(), me = wallet.address;
  const sweep = (f?.curves ?? []).filter((x) => !x.buyback && BigInt(x.feeWei) + BigInt(x.taxWei) > 5_000_000_000_000n);
  let i = 0;
  for (const x of sweep) await send(sg, { to: x.curve, data: sweepI.encodeFunctionData("sweepFees", [0n]) }, `Collect $${x.symbol} fees (${++i}/${sweep.length})`, onStep);
  const [bal] = await call(f.escrow, escrowI, "balanceOf", [me]);
  if (bal === 0n) throw new Error("Nothing to claim yet.");
  const rc = await send(sg, { to: f.escrow, data: escrowI.encodeFunctionData("claim") }, "Claim fees", onStep);
  return { wei: bal, hash: rc.hash };
}
