// Buy / sell box for one token on its Pons curve. Quotes come from the curve's own reserves; writes are signed in the wallet.
import { buy, sell, curveState, quoteBuy, quoteSell, parseEther, formatEther, txUrl, why } from "./chain.js";
import { wallet, connect } from "./wallet.js";

const CFG = window.HUBGPU_CONFIG;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtTok = (v) => (+formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: 0 });

/** coin: { token, curve, symbol, grad, taxBps } */
export function mountTradeBox(el, coin, { onDone } = {}) {
  if (coin.grad) {
    el.innerHTML = `<p class="sub">$${esc(coin.symbol)} graduated to Uniswap. Trade it on Pons.</p><a class="primary wide center" href="${CFG.chain.pons}/${coin.token}" target="_blank" rel="noopener">Trade on Pons ↗</a>`;
    return { refresh() {} };
  }
  let side = "buy", st = null;
  el.innerHTML = `
    <div class="chips small tside"><button type="button" data-side="buy" aria-pressed="true">Buy</button><button type="button" data-side="sell" aria-pressed="false">Sell</button></div>
    <p class="sub tpos" data-k="pos">${wallet.address ? "Reading your position…" : "Connect a wallet to trade"}</p>
    <div class="trow"><input data-k="amt" inputmode="decimal" placeholder="0.001" autocomplete="off"><span data-k="unit">ETH</span></div>
    <div class="chips small" data-k="quick"></div>
    <p class="sub" data-k="quote">&nbsp;</p>
    <button type="button" class="primary wide" data-k="go">${wallet.address ? `Buy $${esc(coin.symbol)}` : "Connect wallet"}</button>
    <p class="sub" data-k="msg">Every trade pays the 1% Pons curve fee${coin.taxBps ? ` + ${coin.taxBps / 100}% creator tax` : ""}. Slippage limit 8%.</p>`;
  const $ = (k) => el.querySelector(`[data-k="${k}"]`);
  const quick = () => {
    $("quick").innerHTML = side === "buy"
      ? ["0.001", "0.005", "0.01", "0.05"].map((v) => `<button type="button" data-q="${v}">${v}</button>`).join("")
      : [25, 50, 75, 100].map((v) => `<button type="button" data-p="${v}">${v === 100 ? "All" : v + "%"}</button>`).join("");
  };
  const label = () => { $("go").textContent = wallet.address ? `${side === "buy" ? "Buy" : "Sell"} $${coin.symbol}` : "Connect wallet"; };
  const quote = () => {
    const v = $("amt").value.trim();
    if (!st || !(+v > 0)) { $("quote").innerHTML = "&nbsp;"; return; }
    try {
      $("quote").textContent = side === "buy" ? `≈ ${fmtTok(quoteBuy(st, parseEther(v)))} $${coin.symbol}` : `≈ ${(+formatEther(quoteSell(st, parseEther(v)))).toFixed(6)} ETH`;
    } catch { $("quote").innerHTML = "&nbsp;"; }
  };
  const refresh = async () => {
    try { st = await curveState(coin); } catch { st = null; }
    if (st && wallet.address) $("pos").textContent = `You hold ${fmtTok(st.tok)} $${coin.symbol} · ${(+formatEther(st.eth)).toFixed(4)} ETH in the wallet`;
    else if (!wallet.address) $("pos").textContent = "Connect a wallet to trade";
    label(); quote();
  };
  el.querySelector(".tside").onclick = (e) => {
    const b = e.target.closest("[data-side]"); if (!b) return;
    side = b.dataset.side;
    el.querySelectorAll(".tside button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    $("unit").textContent = side === "buy" ? "ETH" : "$" + coin.symbol;
    $("amt").value = ""; quick(); label(); quote();
  };
  $("quick").onclick = (e) => {
    const q = e.target.closest("[data-q]"), p = e.target.closest("[data-p]");
    if (q) $("amt").value = q.dataset.q;
    if (p && st) $("amt").value = String(+formatEther((st.tok * BigInt(p.dataset.p)) / 100n));
    quote();
  };
  $("amt").oninput = quote;
  $("go").onclick = async () => {
    if (!wallet.address) { await connect().catch(() => {}); return; }
    const v = $("amt").value.trim();
    if (!(+v > 0)) return $("amt").focus();
    const go = $("go"), msg = $("msg");
    go.disabled = true;
    try {
      const h = side === "buy" ? await buy(coin, parseEther(v), (t) => (msg.textContent = t)) : await sell(coin, parseEther(v), (t) => (msg.textContent = t));
      msg.innerHTML = `Done. <a href="${txUrl(h)}" target="_blank" rel="noopener">tx ↗</a>`;
      $("amt").value = "";
      refresh(); onDone?.();
    } catch (e) { msg.textContent = e?.need ? why(e) : e.message || why(e); }
    go.disabled = false;
  };
  quick();
  wallet.on(() => refresh());
  return { refresh };
}
