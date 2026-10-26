// Token page /t/0x…: the seal and birth record, live market cap and curve, chart, trades, holders, buy/sell.
import { mountWalletButton } from "./wallet.js";
import { mountTradeBox } from "./tradebox.js";
import { groupBits } from "./forge.js";

const CFG = window.HUBGPU_CONFIG;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const ipfs = (u) => (u || "").replace(/^ipfs:\/\//, "/ipfs/");   // served and cached by our own server
// a slow or missing IPFS gateway falls back once to a second gateway, then to a plain tile
window.__sealErr ??= (img) => { if (!img.dataset.alt && /\/ipfs\//.test(img.src)) { img.dataset.alt = 1; img.src = img.src.replace(/^.*\/ipfs\//, "https://gateway.pinata.cloud/ipfs/"); } else img.classList.add("noimg"); };
const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
const compact = (v) => (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0));
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? "now" : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`; };
const pct = (p) => { const v = p * 100; return v >= 1 ? v.toFixed(2) + "%" : v > 0 ? v.toFixed(Math.min(8, 1 - Math.floor(Math.log10(v)))) + "%" : "0%"; };

mountWalletButton($("#wbtn"));
const ca = location.pathname.split("/").pop();

async function load() {
  const r = await fetch(`/api/coin/${ca}`);
  if (!r.ok) { $("#tk").innerHTML = `<section class="card"><h1 class="forge-h">Not a HubGPU token</h1><p class="forge-p">This address was not born on HubGPU, or its launch has not been read yet. <a class="linkish" href="/app">Back to the launchpad</a></p></section>`; return null; }
  return r.json();
}


function render(c) {
  document.title = `$${c.symbol} — ${c.name} · HubGPU`;
  $("#crumb").textContent = "$" + c.symbol;
  const pons = `${CFG.chain.pons}/${c.token}`;
  $("#tk").innerHTML = `
  <div class="tk-grid">
    <aside class="tk-side">
      <section class="card">
        <img class="tk-seal" src="${esc(ipfs(c.logo))}" alt="" onerror="__sealErr(this)">
        <div class="tk-name"><h1>$${esc(c.symbol)}</h1><span class="sub">${esc(c.name)}</span></div>
        ${c.about?.desc ? `<p class="tk-desc">${esc(c.about.desc)}</p>` : ""}
        <div class="badges">${c.rare ? `<span class="badge dark">Rare · 16 qubits</span>` : ""}${c.featured ? `<span class="badge">Featured</span>` : ""}</div>
        <span class="tl">Born from</span>
        <b class="bits">|${esc(groupBits(c.bits))}⟩</b>
        <dl class="bstats">
          <div><dt>Chance of that outcome</dt><dd>${c.p ? pct(c.p) : "–"}</dd></div>
          <div><dt>Measured on</dt><dd>${esc(c.gpu || "–")}</dd></div>
          <div><dt>Creator tax</dt><dd>${c.state && c.state.taxBps != null ? (Number(c.state.taxBps) / 100).toString() + "%" : "–"}</dd></div>
          <div><dt>Born</dt><dd>${new Date(c.t).toISOString().slice(0, 16).replace("T", " ")} UTC</dd></div>
          <div><dt>Creator</dt><dd class="mono"><a class="linkish" href="${CFG.chain.explorer}/address/${c.creator}" target="_blank" rel="noopener">${short(c.creator)}</a></dd></div>
          <div><dt>Contract</dt><dd class="mono"><button type="button" class="linkish" id="tk-ca">${short(c.token)}</button></dd></div>
        </dl>
        <div class="links">${c.about?.x ? `<a href="${esc(c.about.x)}" target="_blank" rel="noopener">X ↗</a>` : ""}${c.about?.tg ? `<a href="${esc(c.about.tg)}" target="_blank" rel="noopener">Telegram ↗</a>` : ""}<a href="${pons}" target="_blank" rel="noopener">Pons ↗</a><a href="${CFG.chain.explorer}/token/${c.token}" target="_blank" rel="noopener">Blockscout ↗</a><a href="https://dexscreener.com/robinhood/${c.token}" target="_blank" rel="noopener">DexScreener ↗</a><a href="${CFG.chain.explorer}/tx/${c.tx}" target="_blank" rel="noopener">Birth tx ↗</a></div>
      </section>
    </aside>

    <section class="tk-main">
      <div class="card tk-head">
        <div class="score"><span class="tl">Market cap</span><b id="tk-mcap">${c.mcap ? usd(c.mcap) : "–"}</b></div>
        <div class="score"><span class="tl">Bonding curve</span><b id="tk-prog">${c.grad ? "Graduated" : (c.progress * 100).toFixed(1) + "%"}</b><span class="c-bar"><i id="tk-bar" style="width:${c.grad ? 100 : Math.max(1, c.progress * 100)}%"></i></span></div>
        <div class="score"><span class="tl">Raised</span><b id="tk-raised">${c.raised ? c.raised.toFixed(3) + " ETH" : "0 ETH"}</b><span class="unit">of ${CFG.launch.curve.graduationEth} ETH to graduate</span></div>
      </div>
      <div class="card tk-chart-card">
        <div class="card-h"><span class="tl">Market cap · USD</span><div class="chips small" id="tk-tf">${[[60, "1m"], [300, "5m"], [900, "15m"], [3600, "1h"]].map(([v, l]) => `<button type="button" data-tf="${v}" aria-pressed="${v === 300}">${l}</button>`).join("")}</div></div>
        <div class="tk-chart" id="tk-chart"><p class="empty">Reading trades from the curve…</p></div>
      </div>
      <div class="card">
        <div class="card-h"><span class="tl">Trades</span><span class="sub">newest first</span></div>
        <div class="tk-trades" id="tk-trades"><p class="empty">Reading trades…</p></div>
      </div>
    </section>

    <aside class="tk-side">
      <section class="card"><div class="card-h"><span class="tl">Trade</span></div><div id="tk-trade" class="trade-box"></div></section>
      <section class="card"><div class="card-h"><span class="tl">Holders</span><span class="sub" id="tk-hc"></span></div><div id="tk-holders"><p class="empty">Reading holders…</p></div></section>
    </aside>
  </div>`;
  $("#tk-ca").onclick = async () => { try { await navigator.clipboard.writeText(c.token); $("#tk-ca").textContent = "Copied"; setTimeout(() => ($("#tk-ca").textContent = short(c.token)), 1200); } catch { /* blocked */ } };
  const box = mountTradeBox($("#tk-trade"), { token: c.token, curve: c.curve, symbol: c.symbol, grad: c.grad, taxBps: c.state?.taxBps || 0 }, { onDone: () => { chart?.refresh(); tick(); } });
  let chart = null;
  mountChart($("#tk-chart"), c).then((ch) => (chart = ch));
  $("#tk-tf").onclick = (e) => { const b = e.target.closest("[data-tf]"); if (!b || !chart) return; $("#tk-tf").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); chart.setTf(+b.dataset.tf); };
  holders(c);
  const tick = async () => {
    const r = await fetch(`/api/coin/${ca}`).catch(() => null);
    if (!r?.ok) return;
    const n = await r.json();
    $("#tk-mcap").textContent = n.mcap ? usd(n.mcap) : "–";
    $("#tk-prog").textContent = n.grad ? "Graduated" : (n.progress * 100).toFixed(1) + "%";
    $("#tk-bar").style.width = `${n.grad ? 100 : Math.max(1, n.progress * 100)}%`;
    $("#tk-raised").textContent = n.raised ? n.raised.toFixed(3) + " ETH" : "0 ETH";
  };
  setInterval(() => !document.hidden && tick(), 15000);
  void box;
}

function tradesHTML(list, sym) {
  if (!list?.length) return `<p class="empty">No trades yet. The first buy draws the first candle.</p>`;
  return list.slice(0, 40).map((t) => `<div class="ttr"><span class="side ${t.side}">${t.side}</span><span class="mono">${short(t.who)}</span><span class="mono">${compact(t.tokens)} $${esc(sym)}</span><span class="mono">${t.eth.toFixed(4)} ETH</span><a class="mono" href="${CFG.chain.explorer}/tx/${t.tx}" target="_blank" rel="noopener">${ago(t.t)}</a></div>`).join("");
}

let lw;
const loadLW = () => (lw ??= window.LightweightCharts ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/vendor/lightweight-charts.js"; s.onload = res; s.onerror = rej; document.head.append(s); }));
async function mountChart(el, c) {
  if (c.grad) { el.innerHTML = `<iframe title="Chart" src="https://dexscreener.com/robinhood/${c.token}?embed=1&theme=light&trades=0&info=0" style="width:100%;height:100%;border:0"></iframe>`; return { refresh() {}, setTf() {} }; }
  await loadLW();
  el.innerHTML = `<div class="tk-chart-empty" hidden><b>No trades yet</b><span>The first buy draws the first candle.</span></div>`;
  const LW = window.LightweightCharts;
  const chart = LW.createChart(el, {
    autoSize: true,
    layout: { background: { color: "transparent" }, textColor: "#9a9ca3", fontFamily: "General Sans, system-ui, sans-serif", fontSize: 11 },
    grid: { vertLines: { color: "rgba(0,0,0,.04)" }, horzLines: { color: "rgba(0,0,0,.05)" } },
    rightPriceScale: { borderColor: "rgba(0,0,0,.08)" },
    timeScale: { borderColor: "rgba(0,0,0,.08)", timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0, vertLine: { color: "rgba(0,0,0,.25)", labelBackgroundColor: "#0c0d12" }, horzLine: { color: "rgba(0,0,0,.25)", labelBackgroundColor: "#0c0d12" } },
    localization: { priceFormatter: (v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 2 : 0 }) },
  });
  const series = chart.addCandlestickSeries({ upColor: "#0c0d12", downColor: "#c4c4c8", borderUpColor: "#0c0d12", borderDownColor: "#a9a9ad", wickUpColor: "#0c0d12", wickDownColor: "#a9a9ad", priceFormat: { type: "custom", formatter: (v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 2 : 0 }), minMove: 0.01 } });
  const vol = chart.addHistogramSeries({ priceScaleId: "v", priceFormat: { type: "volume" } });
  chart.priceScale("v").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  let tf = 300;
  const refresh = async (fit) => {
    try {
      const d = await (await fetch(`/api/coin/${c.token}/candles?tf=${tf}`)).json();
      const cs = d.candles || [];
      el.querySelector(".tk-chart-empty").hidden = cs.length > 0;
      series.setData(cs.map((k) => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close })));
      vol.setData(cs.map((k) => ({ time: k.time, value: k.volume, color: k.close >= k.open ? "rgba(12,13,18,.18)" : "rgba(12,13,18,.07)" })));
      if (fit) chart.timeScale().fitContent();
      $("#tk-trades").innerHTML = tradesHTML(d.trades, c.symbol);
    } catch { /* next tick */ }
  };
  await refresh(true);
  setInterval(() => !document.hidden && refresh(false), 12000);
  return { refresh: () => refresh(false), setTf(v) { tf = v; refresh(true); } };
}

async function holders(c) {
  try {
    const h = await (await fetch(`/api/coin/${c.token}/holders`)).json();
    $("#tk-hc").textContent = h.count ? `${h.count.toLocaleString()} holders` : "";
    $("#tk-holders").innerHTML = h.top?.length ? h.top.slice(0, 12).map((x, i) => {
      const tag = x.addr.toLowerCase() === c.curve.toLowerCase() ? "bonding curve" : x.addr.toLowerCase() === c.creator.toLowerCase() ? "creator" : x.contract ? "contract" : "";
      return `<div class="hold"><span class="mono muted">${i + 1}</span><a class="mono" href="${CFG.chain.explorer}/address/${x.addr}" target="_blank" rel="noopener">${short(x.addr)}</a><span class="sub">${tag}</span><span class="mono">${x.pct.toFixed(2)}%</span></div>`;
    }).join("") : `<p class="empty">No holders yet.</p>`;
  } catch { $("#tk-holders").innerHTML = `<p class="empty">Could not read holders right now.</p>`; }
}

// start once every helper above is defined
const c = await load();
if (c) render(c);
