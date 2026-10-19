// Launchpad view. A four-step wizard: name → measure (the creator's GPU runs the birth circuit) → details → check and
// launch on Pons, with a live preview of the token beside it and a success screen after. Below: live activity, the
// Featured row and every token born here. The My tokens tab lists the wallet's launches and claims its creator fees.
import { measureBirth, drawSeal, groupBits } from "./forge.js";
import { launchToken, firstBuyShare, terms, hubTerms, claimFees, pendingWei, formatEther, txUrl, why, xUrl, tgUrl, ethBalance, networkFeeWei } from "./chain.js";
import { wallet, mountWalletButton, connect } from "./wallet.js";

const CFG = window.HUBGPU_CONFIG;
const L = CFG.launch;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const ipfs = (u) => (u || "").replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/");
// a slow or missing IPFS gateway falls back once to a second gateway, then to a plain tile
window.__sealErr ??= (img) => { if (!img.dataset.alt && /ipfs\.io/.test(img.src)) { img.dataset.alt = 1; img.src = img.src.replace("https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"); } else img.classList.add("noimg"); };
const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`; };
const pct = (p) => { const v = p * 100; return v >= 1 ? v.toFixed(2) + "%" : v > 0 ? v.toFixed(Math.min(8, 1 - Math.floor(Math.log10(v)))) + "%" : "0%"; };
const num = (v) => Number(v).toLocaleString();
const eth = (v) => (v === 0 ? "0" : v < 0.0001 ? "< 0.0001" : (+v.toFixed(5)).toString());

const st = {
  step: 1, birth: null, buyEth: L.buyPresets[1] ?? L.minBuyEth, taxPct: 0, ponsFee: 0, netFee: 0, balance: null,
  symTaken: false, busy: false, done: null,
};
let holder = { ca: "", rare: false, featured: false, balance: 0, rareMin: CFG.holder?.rare || 0, featuredMin: CFG.holder?.featured || 0 };
let hub = { fee: 0, holder: false, contract: false };
let wantRare = true;
let engineReady;

export function initLaunchpad(ready) {
  engineReady = ready;
  mountWalletButton($("#wbtn"));
  ready.then((eng) => { $("#forge-dev").textContent = eng.kind === "gpu" ? `runs on your ${eng.label}` : "CPU mode (no WebGPU)"; });
  terms().then((t) => { st.ponsFee = Number(t.launchFeeWei) / 1e18; refresh(); }).catch(() => {});
  networkFeeWei().then((w) => { st.netFee = Number(w) / 1e18; refresh(); }).catch(() => {});
  wallet.on(() => { readHolder(); readHub(); readBalance(); loadMine(); });

  // step 1
  const name = $("#f-name"), sym = $("#f-sym");
  let symTimer = 0;
  name.addEventListener("input", () => { invalidateBirth(); refresh(); });
  sym.addEventListener("input", () => {
    sym.value = sym.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    invalidateBirth(); refresh();
    clearTimeout(symTimer); symTimer = setTimeout(checkTicker, 300);
  });
  // step 2
  $("#f-measure").addEventListener("click", measure);
  $("#f-again").addEventListener("click", measure);
  $("#holder").addEventListener("change", (e) => { if (e.target.id === "f-rare") { wantRare = e.target.checked; invalidateBirth(); refresh(); } });
  // step 3
  ["#f-desc", "#f-x", "#f-tg"].forEach((s) => $(s).addEventListener("input", refresh));
  $("#f-buy").innerHTML = L.buyPresets.map((v) => `<button type="button" data-v="${v}" aria-pressed="${v === st.buyEth}">${v} ETH</button>`).join("");
  $("#f-tax").innerHTML = L.taxOptions.map((v) => `<button type="button" data-v="${v}" aria-pressed="${v === st.taxPct}">${v}%</button>`).join("");
  $("#f-buy").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b) return; st.buyEth = +b.dataset.v; $("#f-buy-own").value = ""; refresh(); });
  $("#f-buy-own").addEventListener("input", (e) => { const v = parseFloat(e.target.value); if (v > 0) st.buyEth = v; refresh(); });
  $("#f-tax").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b) return; st.taxPct = +b.dataset.v; refresh(); });
  // step 4 / 5
  $("#f-launch").addEventListener("click", doLaunch);
  $("#d-new").addEventListener("click", reset);
  $("#d-ca").addEventListener("click", async () => { try { await navigator.clipboard.writeText(st.done.token); $("#d-ca").dataset.copied = "1"; setTimeout(() => delete $("#d-ca").dataset.copied, 1200); } catch { /* blocked */ } });
  // nav
  $("#w-back").addEventListener("click", () => go(st.step - 1));
  $("#w-next").addEventListener("click", () => { const w = blocker(); if (!w) go(st.step + 1); else $("#w-why").textContent = w; });
  $("#stepper").addEventListener("click", (e) => { const li = e.target.closest("[data-s]"); if (!li || st.step === 5) return; const n = +li.dataset.s; if (n < st.step || canReach(n)) go(n); });

  // explore
  $("#b-sort").addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (!b) return; $("#b-sort").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); sort = b.dataset.s; loadBorn(); });
  let qt = 0;
  $("#b-q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(loadBorn, 220); });
  $("#m-claim").addEventListener("click", doClaim);
  readHolder(); readHub();
  go(1);
  loadBorn(); loadLive();
  setInterval(() => { if (document.hidden) return; if (!$("#view-launchpad").hidden) { loadBorn(); loadLive(); } if (!$("#view-mine").hidden) loadMine(); }, 20000);
}

/* ── wizard ─────────────────────────────────────────────── */
const nameOk = () => $("#f-name").value.trim().length >= 1;
const buyOk = () => st.buyEth >= L.minBuyEth && st.buyEth <= 1;
const xBad = () => $("#f-x").value.trim() && !xUrl($("#f-x").value);
const tgBad = () => $("#f-tg").value.trim() && !tgUrl($("#f-tg").value);
function blocker(step = st.step) {
  if (step === 1) return !nameOk() ? "Give it a name." : !$("#f-sym").value ? "Pick a ticker." : st.symTaken ? "That ticker is taken on HubGPU." : "";
  if (step === 2) return !st.birth ? "Run the machine first." : "";
  if (step === 3) return !buyOk() ? `First buy: between ${L.minBuyEth} and 1 ETH.` : xBad() ? "Check the X link." : tgBad() ? "Check the Telegram link." : "";
  return "";
}
function canReach(n) { for (let s = 1; s < n; s++) if (blocker(s)) return false; return true; }

function go(n) {
  n = Math.max(1, Math.min(5, n));
  if (n > st.step && n !== 5 && !canReach(n)) return;
  st.step = n;
  document.querySelectorAll(".wiz .step").forEach((el) => (el.hidden = +el.dataset.step !== n));
  document.querySelectorAll("#stepper li").forEach((li) => { const s = +li.dataset.s; li.classList.toggle("on", s === n); li.classList.toggle("ok", s < n || n === 5); });
  $("#wiz-nav").hidden = n === 5;
  $("#w-back").style.visibility = n === 1 ? "hidden" : "visible";
  $("#w-next").hidden = n >= 4;
  $("#w-why").textContent = "";
  if (n === 2 && !st.birth && !st.busy) measure();       // entering step 2 runs the machine once
  if (n === 4) { readBalance(); readHub(); }
  refresh();
  if (n > 1 && innerWidth < 1000) $("#create").scrollIntoView({ behavior: "smooth", block: "start" });
}

function invalidateBirth() {
  if (!st.birth) return;
  const n = $("#f-name").value.trim(), s = $("#f-sym").value.trim();
  if (st.birth.name !== n || st.birth.symbol !== s || st.birth.rare !== (holder.rare && wantRare)) {
    st.birth = null;
    $("#b-bits").textContent = "–"; $("#b-p").textContent = $("#b-c").textContent = $("#b-dev").textContent = "–";
    $("#seal-empty").hidden = false; $("#seal").classList.add("blank");
    $("#f-measure").hidden = false; $("#f-again").hidden = true;
  }
}

async function checkTicker() {
  const s = $("#f-sym").value;
  const h = $("#h-sym");
  if (!s) { st.symTaken = false; h.textContent = "Letters and digits, up to 10. This is what people search for."; h.className = "hint"; return refresh(); }
  try {
    const j = await (await fetch(`/api/ticker/${s}`)).json();
    if (j.symbol !== $("#f-sym").value) return;
    st.symTaken = j.taken;
    h.innerHTML = j.taken ? `$${esc(s)} is already born on HubGPU. <a class="linkish" href="/t/${j.token}">See it</a> or pick another.` : `$${esc(s)} is free on HubGPU.`;
    h.className = "hint " + (j.taken ? "bad" : "ok");
  } catch { /* offline */ }
  refresh();
}

async function measure() {
  if (st.busy) return;
  const name = $("#f-name").value.trim(), sym = $("#f-sym").value.trim();
  if (!name || !sym) return go(1);
  st.busy = true;
  const btn = $("#f-measure"), again = $("#f-again");
  btn.disabled = again.disabled = true; btn.textContent = "Measuring…";
  $("#birth").classList.add("scanning"); $("#seal-empty").hidden = true;
  const eng = await engineReady;
  const rare = holder.rare && wantRare;
  try {
    const m = await measureBirth(eng, name, sym, { rare });
    await new Promise((r) => setTimeout(r, 650));          // let the scan read as a scan
    st.birth = { ...m, name, symbol: sym, gpu: eng.label };
    drawSeal($("#seal"), m); $("#seal").classList.remove("blank");
    $("#b-bits").textContent = `|${groupBits(m.bits)}⟩`;
    $("#b-p").textContent = pct(m.p);
    $("#b-c").textContent = `${m.n} qubits · ${m.steps} gates · ${m.ms < 1 ? (m.ms * 1000).toFixed(0) + " µs" : m.ms.toFixed(1) + " ms"}`;
    $("#b-dev").textContent = eng.kind === "gpu" ? eng.label : "CPU (no WebGPU)";
    $("#birth").classList.toggle("rare", m.rare);
    btn.hidden = true; again.hidden = false;
  } catch (e) { $("#b-bits").textContent = e.message; }
  $("#birth").classList.remove("scanning");
  btn.disabled = again.disabled = false; btn.textContent = "Run the machine";
  st.busy = false;
  refresh();
}

/* everything that depends on the form: counters, hints, the preview, the cost table, the wallet box */
function refresh() {
  const name = $("#f-name").value.trim(), sym = $("#f-sym").value, desc = $("#f-desc").value.trim();
  $("#c-name").textContent = `${$("#f-name").value.length}/32`;
  $("#c-sym").textContent = `${sym.length}/10`;
  $("#c-desc").textContent = `${$("#f-desc").value.length}/600`;
  $("#h-x").textContent = xBad() ? "Use @handle or x.com/handle" : "";
  $("#h-tg").textContent = tgBad() ? "Use @group or t.me/group" : "";
  $("#f-buy").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", !$("#f-buy-own").value && +b.dataset.v === st.buyEth));
  $("#f-tax").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.v === st.taxPct));
  const share = firstBuyShare(st.buyEth, st.taxPct);
  $("#h-buy").innerHTML = buyOk() ? `You get about <b>${num(Math.round((share / 100) * L.supply))} $${esc(sym || "TOKEN")}</b>, ${share.toFixed(2)}% of the supply, before anyone else can buy.` : `<span class="bad">Between ${L.minBuyEth} and 1 ETH.</span>`;
  $("#h-tax").innerHTML = st.taxPct ? `Every buy and sell pays <b>${st.taxPct}%</b> to you, on top of Pons's 1%. Higher tax earns more per trade but can put traders off.` : "No extra tax. You still earn 70% of Pons's 1% fee on every trade.";
  $("#w-next").disabled = !!blocker();
  // preview
  $("#pv-sym").textContent = "$" + (sym || "TICKER");
  $("#pv-name").textContent = name || "Token name";
  $("#pv-desc").textContent = desc || "Your description shows here.";
  $("#pv-bits").textContent = st.birth ? `|${groupBits(st.birth.bits)}⟩` : "|············⟩";
  $("#pv-tax").textContent = `${st.taxPct}% creator tax`;
  $("#pv-rare").hidden = !st.birth?.rare;
  const pv = $("#pv-seal");
  if (st.birth) { const g = pv.getContext("2d"); g.clearRect(0, 0, pv.width, pv.height); g.drawImage($("#seal"), 0, 0, pv.width, pv.height); }
  pv.classList.toggle("blank", !st.birth); $("#pv-empty").hidden = !!st.birth;
  const links = [xUrl($("#f-x").value) && "X", tgUrl($("#f-tg").value) && "Telegram", "Website"].filter(Boolean);
  $("#pv-links").innerHTML = links.map((l) => `<span>${l}</span>`).join("");
  if (st.step === 4) cost();
}

async function readHub() { try { hub = await hubTerms(wallet.address); } catch { hub = { fee: 0, holder: false, contract: false }; } refresh(); }
async function readBalance() {
  if (!wallet.address) { st.balance = null; return refresh(); }
  try { st.balance = Number(await ethBalance(wallet.address)) / 1e18; } catch { st.balance = null; }
  refresh();
}

function cost() {
  const hubFee = hub.contract ? hub.fee : 0;
  const total = st.ponsFee + hubFee + st.buyEth;
  const rows = [
    ["Pons launch fee", `${eth(st.ponsFee)} ETH`, "paid to Pons"],
    ["HubGPU fee", hub.contract ? (hubFee ? `${eth(hubFee)} ETH` : "Free") : "None", hub.contract ? (hubFee ? `free with ${num(holder.rareMin)} $HGPU` : "you hold $HGPU") : ""],
    ["Your first buy", `${eth(st.buyEth)} ETH`, `≈ ${firstBuyShare(st.buyEth, st.taxPct).toFixed(2)}% of the supply, to your wallet`],
    ["Network fee", `${st.netFee < 0.0001 ? "" : "≈ "}${eth(st.netFee)} ETH`, "Robinhood Chain gas"],
  ];
  $("#cost").innerHTML = rows.map(([k, v, n]) => `<tr><td>${k}${n ? `<small>${n}</small>` : ""}</td><td class="mono">${v}</td></tr>`).join("") + `<tr class="tot"><td>Total</td><td class="mono">${eth(total + st.netFee)} ETH</td></tr>`;
  const need = total + st.netFee;
  let wb;
  if (!wallet.address) wb = `<div class="wb-row"><span>Connect the wallet that will own the token and receive its creator fees.</span><button type="button" class="primary" data-connect>Connect wallet</button></div>`;
  else {
    const enough = st.balance == null || st.balance >= need;
    wb = `<div class="wb-row"><span class="mono">${short(wallet.address)}</span><span class="mono">${st.balance == null ? "…" : eth(st.balance) + " ETH"} on ${CFG.chain.label}</span></div>` +
      (enough ? `<p class="hint ok">Enough ETH for this launch.</p>` : `<p class="hint bad">You need about ${eth(need)} ETH on ${CFG.chain.label}. <a class="linkish" href="${CFG.chain.bridge}" target="_blank" rel="noopener">Bridge ETH ↗</a></p>`);
  }
  $("#walletbox").innerHTML = wb;
  $("#walletbox [data-connect]")?.addEventListener("click", () => connect().catch(() => {}));
  $("#f-launch").textContent = wallet.address ? `Launch $${$("#f-sym").value || "TOKEN"} · ${eth(total)} ETH` : "Connect wallet to launch";
}

/* $HGPU: what the connected wallet unlocks (read on-chain by the server) */
async function readHolder() {
  try { holder = await (await fetch(`/api/holder${wallet.address ? "?wallet=" + wallet.address : ""}`)).json(); } catch { /* keep last */ }
  let html;
  if (!holder.ca) html = `<span class="hold-note"><b>$HGPU holders</b> launch with no HubGPU fee and birth from 16 qubits: a rare seal on a black plate. Unlocks when $HGPU launches.</span>`;
  else if (!wallet.address) html = `<span class="hold-note">Hold <b>${num(holder.rareMin)} $HGPU</b> to launch with no HubGPU fee and birth rare 16-qubit seals. <button type="button" class="linkish" data-connect>Connect</button> to check.</span>`;
  else if (holder.rare) html = `<label class="hold-toggle"><input type="checkbox" id="f-rare" ${wantRare ? "checked" : ""}> <span><b>Rare seal · 16 qubits</b> · no HubGPU fee · you hold ${num(Math.floor(holder.balance))} $HGPU</span></label>`;
  else html = `<span class="hold-note">You hold ${num(Math.floor(holder.balance))} $HGPU. Hold <b>${num(holder.rareMin)}</b> to launch free and birth rare 16-qubit seals${CFG.buyUrl ? ` · <a class="linkish" href="${CFG.buyUrl}" target="_blank" rel="noopener">Buy $HGPU ↗</a>` : ""}.</span>`;
  $("#holder").innerHTML = html;
  $("#holder").querySelector("[data-connect]")?.addEventListener("click", () => connect().catch(() => {}));
  const feat = !holder.ca ? `Creators holding ${num(holder.featuredMin)} $HGPU get their tokens in the Featured row once $HGPU launches.`
    : holder.featured ? `You hold ${num(Math.floor(holder.balance))} $HGPU: your tokens show in the Featured row.`
      : `Hold ${num(holder.featuredMin)} $HGPU and your tokens show in the Featured row.`;
  $("#m-holder").innerHTML = `<span class="hold-note">${feat}</span>`;
  invalidateBirth();
}

function logger(log) {
  log.innerHTML = "";
  let last = null;
  const step = (text, hash) => {
    if (last) last.classList.add("done");
    last = document.createElement("li");
    last.innerHTML = esc(text) + (hash ? ` <a href="${txUrl(hash)}" target="_blank" rel="noopener">tx ↗</a>` : "");
    log.append(last);
  };
  step.ok = () => last?.classList.add("done", "ok");
  step.fail = (msg) => { const li = document.createElement("li"); li.className = "bad"; li.textContent = msg; log.append(li); };
  return step;
}

async function doLaunch() {
  if (!st.birth || st.busy) return;
  if (!wallet.address) { await connect().catch(() => {}); return; }
  st.busy = true;
  const btn = $("#f-launch"), log = $("#f-log");
  btn.disabled = true;
  const step = logger(log);
  try {
    const b = st.birth;
    const png = $("#seal").toDataURL("image/png");
    const r = await launchToken({ name: b.name, symbol: b.symbol, description: $("#f-desc").value, twitter: $("#f-x").value, telegram: $("#f-tg").value, taxPct: st.taxPct, buyEth: st.buyEth, png, bits: b.bits, p: b.p, gpu: b.gpu }, step);
    step(`$${b.symbol} is live on Pons.`, r.hash); step.ok();
    st.done = { ...r, symbol: b.symbol, name: b.name, bits: b.bits };
    success();
    loadBorn(); loadLive(); loadMine();
  } catch (e) { step.fail(e?.need ? why(e) : e.message || why(e)); }
  btn.disabled = false; st.busy = false;
}

function success() {
  const d = st.done;
  const page = d.token ? `${location.origin}/t/${d.token}` : `${location.origin}/app`;
  $("#d-title").textContent = `$${d.symbol} is live on Pons`;
  $("#d-sub").textContent = `${d.name} was born from |${groupBits(d.bits)}⟩ on your GPU. Your first buy is in your wallet, and its creator fees will be too.`;
  $("#d-ca").textContent = d.token || "reading…";
  $("#d-page").href = d.token ? `/t/${d.token}` : "/app";
  $("#d-pons").href = d.token ? `${CFG.chain.pons}/${d.token}` : CFG.chain.pons;
  const text = `I just measured $${d.symbol} into existence on my GPU. Born from |${d.bits}⟩ on @hubgpunetwork`;
  $("#d-share").href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(page)}`;
  go(5);
}

function reset() {
  st.birth = null; st.done = null; st.symTaken = false;
  ["#f-name", "#f-sym", "#f-desc", "#f-x", "#f-tg", "#f-buy-own"].forEach((s) => ($(s).value = ""));
  $("#f-log").innerHTML = "";
  $("#seal-empty").hidden = false; $("#seal").classList.add("blank"); $("#f-measure").hidden = false; $("#f-again").hidden = true;
  $("#b-bits").textContent = "–";
  $("#h-sym").textContent = "Letters and digits, up to 10. This is what people search for."; $("#h-sym").className = "hint";
  go(1);
}

/* ── explore ────────────────────────────────────────────── */
const card = (c) => `
  <a class="coin" href="/t/${c.token}">
    <span class="c-img"><img src="${esc(ipfs(c.logo))}" alt="" loading="lazy" onerror="__sealErr(this)">${c.rare ? `<span class="badge dark">Rare</span>` : ""}</span>
    <span class="c-main"><b>$${esc(c.symbol)}</b><span>${esc(c.name)}</span></span>
    <span class="c-bits">|${esc(groupBits(c.bits))}⟩</span>
    <span class="c-row"><span>${c.mcap ? usd(c.mcap) : "–"}</span><span>${c.grad ? "graduated" : (c.progress * 100).toFixed(1) + "%"}</span></span>
    <span class="c-bar"><i style="width:${c.grad ? 100 : Math.max(1, c.progress * 100)}%"></i></span>
    <span class="c-meta">${esc(short(c.creator))} · ${ago(c.t)}</span>
  </a>`;

let sort = "new";
async function loadBorn() {
  const grid = $("#born-grid"), q = $("#b-q").value.trim();
  let j;
  try { j = await (await fetch(`/api/launches?sort=${sort}${q ? "&q=" + encodeURIComponent(q) : ""}`)).json(); } catch { return; }
  const list = j.launches || [];
  const feat = q ? [] : list.filter((c) => c.featured).slice(0, 6);
  $("#featured").hidden = !feat.length;
  $("#featured-grid").innerHTML = feat.map(card).join("");
  grid.innerHTML = list.length ? list.map(card).join("")
    : q ? `<p class="empty">Nothing matches “${esc(q)}”.</p>` : `<p class="empty">Nothing has been born here yet. Name a token above and run the machine.</p>`;
}

async function loadLive() {
  let j;
  try { j = await (await fetch("/api/activity")).json(); } catch { return; }
  const items = j.items || [];
  if (!items.length) return;
  $("#live").innerHTML = items.slice(0, 14).map((a) => a.kind === "born"
    ? `<a class="lv" href="/t/${a.token}"><b>$${esc(a.symbol)}</b> born${a.rare ? " · rare" : ""} <span>${ago(a.t)}</span></a>`
    : `<a class="lv" href="/t/${a.token}">${short(a.who)} ${a.kind === "buy" ? "bought" : "sold"} <b>$${esc(a.symbol)}</b> · ${a.eth.toFixed(4)} ETH <span>${ago(a.t)}</span></a>`).join("");
}

/* ── My tokens: the connected wallet's launches and the fees waiting for it ── */
let fees = null;
async function loadMine() {
  const grid = $("#m-grid");
  if (!wallet.address) {
    $("#m-who").textContent = "not connected"; $("#m-fee").textContent = "–"; $("#m-count").textContent = "";
    grid.innerHTML = `<p class="empty">Connect a wallet to see the tokens you launched here. <button type="button" class="linkish" id="m-connect">Connect</button></p>`;
    $("#m-connect")?.addEventListener("click", () => connect().catch(() => {}));
    return;
  }
  $("#m-who").textContent = short(wallet.address);
  try {
    const j = await (await fetch(`/api/launches?creator=${wallet.address}`)).json();
    $("#m-count").textContent = j.launches.length ? `${j.launches.length} token${j.launches.length > 1 ? "s" : ""}` : "";
    grid.innerHTML = j.launches.length ? j.launches.map(card).join("") : `<p class="empty">No tokens launched from this wallet yet. <a class="linkish" href="/app">Birth one</a>.</p>`;
  } catch { /* keep */ }
  try {
    fees = await (await fetch(`/api/fees?wallet=${wallet.address}`)).json();
    $("#m-fee").textContent = `${(+formatEther(pendingWei(fees))).toFixed(6)} ETH`;
  } catch { $("#m-fee").textContent = "–"; }
}

async function doClaim() {
  if (!wallet.address) return connect().catch(() => {});
  if (!fees || pendingWei(fees) === 0n) { logger($("#m-log")).fail("Nothing to claim yet."); return; }
  const btn = $("#m-claim"); btn.disabled = true;
  const step = logger($("#m-log"));
  try {
    const r = await claimFees(fees, step);
    step(`Claimed ${(+formatEther(r.wei)).toFixed(6)} ETH to your wallet.`, r.hash); step.ok();
    loadMine();
  } catch (e) { step.fail(e?.need ? why(e) : e.message || why(e)); }
  btn.disabled = false;
}
