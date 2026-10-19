// Quantum Lab: composer, qubit test, leaderboard. Every number on this page is
// computed on the visitor's device (WebGPU, or the CPU when WebGPU is missing).
import { createGPU, CPUEngine } from "./engine.js";
import { GATES, compile, randomCircuit, checkCircuit, topOutcomes, CHECK_N } from "./gates.js";
import { initLaunchpad } from "./launchpad.js";

const $ = (s) => document.querySelector(s);
const fmt = (x, d = 3) => (Math.abs(x) < 5e-4 ? (0).toFixed(d) : x.toFixed(d));
const bits = (i, n) => i.toString(2).padStart(n, "0");

/* ── engine ──────────────────────────────────────────────── */
let engine = null;
const ready = (async () => {
  try { engine = await createGPU(); } catch (e) { console.warn("webgpu", e); }
  const dev = $("#device");
  if (engine) {
    dev.classList.add("on");
    $("#device-label").textContent = `WebGPU · ${engine.label} · up to ${engine.maxQubits} qubits`;
    dev.title = engine.description || engine.label;
  } else {
    engine = new CPUEngine();
    dev.classList.add("cpu");
    $("#device-label").textContent = "CPU mode · this browser has no WebGPU";
  }
  return engine;
})();

/* ── tabs ────────────────────────────────────────────────── */
function show(view) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === "board") loadBoard();
  history.replaceState(null, "", view === "launchpad" ? "/app" : `/app#${view}`);
}
document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.view); });

/* ══ Composer ═══════════════════════════════════════════════ */
const MAXQ = 16, COLS = 18, SHOTS = 1024;
let n = 3;
let cols = Array.from({ length: COLS }, () => []);   // each: [{ g, q, q2?, theta? }]
let history_ = [];
let tool = { g: "h", theta: Math.PI / 2 };
let pending = null;                                   // first click of a two-qubit gate: { col, q }

const ANGLES = [["π/8", Math.PI / 8], ["π/4", Math.PI / 4], ["π/2", Math.PI / 2], ["π", Math.PI], ["3π/2", 1.5 * Math.PI]];
const glyphClass = (g) => (g === "h" ? "h" : ["s", "t"].includes(g) ? "ph" : ["rx", "ry", "rz"].includes(g) ? "r" : GATES[g].kind === 2 ? "two" : "p");
const angleLabel = (t) => (ANGLES.find(([, v]) => Math.abs(v - t) < 1e-9) || [t.toFixed(2)])[0];

function renderPalette() {
  const groups = [["Superposition & flips", ["h", "x", "y", "z"]], ["Phase", ["s", "t"]], ["Rotations", ["rx", "ry", "rz"]], ["Two qubits", ["cx", "cz", "swap"]]];
  let html = "";
  for (const [title, gs] of groups) {
    html += `<span class="tl pgt">${title}</span><div class="gtiles">`;
    for (const g of gs) {
      const G = GATES[g];
      html += `<button type="button" class="gbtn" data-g="${g}" aria-pressed="${tool.g === g}" title="${G.name}: ${G.tip}"><span class="gl ${glyphClass(g)}">${G.label}</span><span class="nm">${G.name}</span></button>`;
    }
    html += `</div>`;
    if (title === "Rotations") html += `<div class="angles">${ANGLES.map(([l, v]) => `<button type="button" data-a="${v}" aria-pressed="${Math.abs(tool.theta - v) < 1e-9}">${l}</button>`).join("")}</div>`;
  }
  const G = GATES[tool.g];
  html += `<div class="about"><b>${G.name}</b><p>${G.tip}</p></div>`;
  $("#palette").innerHTML = html;
}
$("#palette").addEventListener("click", (e) => {
  const gb = e.target.closest(".gbtn"), ab = e.target.closest("[data-a]");
  if (gb) { tool.g = gb.dataset.g; pending = null; }
  if (ab) tool.theta = +ab.dataset.a;
  renderPalette(); renderCircuit(); hint();
});

function hint(msg) {
  const G = GATES[tool.g];
  $("#hint").textContent = msg || (pending ? `${G.name}: now click the target qubit in the same column.` : G.kind === 2 ? `${G.name}: click the control qubit first.` : `${G.name}${G.angle ? ` by ${angleLabel(tool.theta)}` : ""}: click a wire to place it. Click a gate to remove it.`);
}

function occupied(col, q) {
  return cols[col].find((o) => o.q === q || o.q2 === q || (o.q2 !== undefined && q > Math.min(o.q, o.q2) && q < Math.max(o.q, o.q2)));
}
function snapshot() { history_.push(JSON.stringify({ n, cols })); if (history_.length > 60) history_.shift(); }

function onCell(col, q) {
  const hit = occupied(col, q);
  if (hit && !pending) {
    snapshot();
    cols[col] = cols[col].filter((o) => o !== hit);
    return changed();
  }
  const G = GATES[tool.g];
  if (G.kind === 1) {
    if (hit) return;
    snapshot();
    cols[col].push(G.angle ? { g: tool.g, q, theta: tool.theta } : { g: tool.g, q });
    return changed();
  }
  if (!pending) { if (hit) return; pending = { col, q }; renderCircuit(); return hint(); }
  if (pending.col !== col || pending.q === q) { pending = null; renderCircuit(); return hint(); }
  const lo = Math.min(pending.q, q), hi = Math.max(pending.q, q);
  for (let k = lo; k <= hi; k++) if (occupied(col, k)) { pending = null; renderCircuit(); return hint("That column already has a gate in the way."); }
  snapshot();
  cols[col].push({ g: tool.g, q: pending.q, q2: q });
  pending = null;
  changed();
}

function renderCircuit(probs) {
  const H = 44;
  let html = `<div class="grid" style="grid-template-columns: max-content repeat(${COLS}, 44px) max-content">`;
  for (let q = n - 1; q >= 0; q--) {
    html += `<div class="wire-label">q${q}<em>|0⟩</em></div>`;
    for (let c = 0; c < COLS; c++) {
      let inner = "";
      const o = cols[c].find((x) => x.q === q || x.q2 === q);
      if (o) {
        if (GATES[o.g].kind === 1) inner = `<span class="gl ${glyphClass(o.g)}">${GATES[o.g].label}${GATES[o.g].angle ? `<small>${angleLabel(o.theta)}</small>` : ""}</span>`;
        else if (o.g === "swap") inner = `<span class="sw">×</span>`;
        else if (o.q === q) inner = `<span class="dot"></span>`;
        else inner = o.g === "cx" ? `<span class="tgt"></span>` : `<span class="dot"></span>`;
      }
      const pend = pending && pending.col === c && pending.q === q ? " pending" : "";
      html += `<div class="cell${pend}" data-c="${c}" data-q="${q}">${inner}</div>`;
    }
    const p1 = probs ? probs[q] : 0;
    html += `<div class="meter" title="Chance this qubit reads 1">P(1) <i><b style="width:${(p1 * 100).toFixed(1)}%"></b></i> ${(p1 * 100).toFixed(0)}%</div>`;
  }
  html += `</div>`;
  $("#circuit").innerHTML = html;
  // vertical links for two-qubit gates
  const grid = $("#circuit .grid");
  const labelW = grid.querySelector(".wire-label").offsetWidth;
  for (let c = 0; c < COLS; c++) for (const o of cols[c]) {
    if (o.q2 === undefined) continue;
    const top = (n - 1 - Math.max(o.q, o.q2)) * H + H / 2, bot = (n - 1 - Math.min(o.q, o.q2)) * H + H / 2;
    const el = document.createElement("div");
    el.className = "vlink";
    el.style.cssText = `left:${labelW + c * 44 + 22}px;top:${top}px;height:${bot - top}px`;
    grid.append(el);
  }
}
$("#circuit").addEventListener("click", (e) => { const c = e.target.closest(".cell"); if (c) onCell(+c.dataset.c, +c.dataset.q); });

/* presets */
const PRESETS = {
  "Empty": () => [],
  "Superposition": () => [Array.from({ length: n }, (_, q) => ({ g: "h", q }))],
  "Bell pair": () => (n < 2 ? null : [[{ g: "h", q: 0 }], [{ g: "cx", q: 0, q2: 1 }]]),
  "GHZ": () => (n < 2 ? null : [[{ g: "h", q: 0 }], ...Array.from({ length: n - 1 }, (_, i) => [{ g: "cx", q: i, q2: i + 1 }])]),
  "Grover · find 11": () => (n < 2 ? null : [
    [{ g: "h", q: 0 }, { g: "h", q: 1 }], [{ g: "cz", q: 0, q2: 1 }],
    [{ g: "h", q: 0 }, { g: "h", q: 1 }], [{ g: "x", q: 0 }, { g: "x", q: 1 }], [{ g: "cz", q: 0, q2: 1 }],
    [{ g: "x", q: 0 }, { g: "x", q: 1 }], [{ g: "h", q: 0 }, { g: "h", q: 1 }]]),
  "Phase kickback": () => (n < 2 ? null : [[{ g: "h", q: 0 }, { g: "x", q: 1 }], [{ g: "h", q: 1 }], [{ g: "cx", q: 0, q2: 1 }], [{ g: "h", q: 0 }]]),
  "Random": () => {
    const out = [];
    for (let c = 0; c < 8; c++) {
      const col = [];
      for (let q = 0; q < n; q++) if (Math.random() < 0.55) col.push({ g: ["h", "x", "ry", "rz", "t"][Math.floor(Math.random() * 5)], q, theta: ANGLES[Math.floor(Math.random() * 5)][1] });
      out.push(col);
      if (n > 1) { const q = Math.floor(Math.random() * (n - 1)); out.push([{ g: Math.random() < 0.5 ? "cx" : "cz", q, q2: q + 1 }]); }
    }
    return out.slice(0, COLS);
  },
};
$("#presets").innerHTML = Object.keys(PRESETS).map((k) => `<button type="button" data-p="${k}">${k}</button>`).join("");
$("#presets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-p]"); if (!b) return;
  const built = PRESETS[b.dataset.p]();
  if (!built) return hint("That one needs at least two qubits.");
  snapshot();
  cols = Array.from({ length: COLS }, (_, i) => built[i] || []);
  pending = null; changed();
});
$("#q-dec").addEventListener("click", () => setN(n - 1));
$("#q-inc").addEventListener("click", () => setN(n + 1));
function setN(v) {
  v = Math.max(1, Math.min(MAXQ, v));
  if (v === n) return;
  snapshot();
  n = v;
  cols = cols.map((c) => c.filter((o) => o.q < n && (o.q2 === undefined || o.q2 < n)));
  pending = null; changed();
}
$("#clear").addEventListener("click", () => { snapshot(); cols = Array.from({ length: COLS }, () => []); pending = null; changed(); });
$("#undo").addEventListener("click", () => {
  const s = history_.pop(); if (!s) return;
  ({ n, cols } = JSON.parse(s)); pending = null; changed(false);
});

/* simulation */
let runId = 0, queued = false;
function changed() {
  $("#q-n").textContent = n;
  renderCircuit(); hint();
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; simulate(); });
}

async function simulate() {
  const id = ++runId;
  const eng = await ready;
  const ops = cols.flat();
  const steps = compile(ops);
  let ms;
  try { ms = await eng.run(n, steps); } catch (e) { $("#run-info").textContent = e.message; return; }
  const st = await eng.read();
  if (id !== runId) return;
  const size = 1 << n, p = new Float64Array(size);
  for (let i = 0; i < size; i++) p[i] = st.re[i] * st.re[i] + st.im[i] * st.im[i];
  // per-qubit P(1) and Bloch vectors
  const p1 = new Array(n).fill(0), bloch = [];
  for (let q = 0; q < n; q++) {
    const bit = 1 << q;
    let rr = 0, ri = 0, a = 0, b = 0;
    for (let i = 0; i < size; i++) {
      if (i & bit) continue;
      const j = i | bit;
      rr += st.re[i] * st.re[j] + st.im[i] * st.im[j];
      ri += st.im[i] * st.re[j] - st.re[i] * st.im[j];
      a += p[i]; b += p[j];
    }
    p1[q] = b;
    bloch.push({ x: 2 * rr, y: -2 * ri, z: a - b });
  }
  // shots sampled from the exact distribution
  const cdf = new Float64Array(size); let acc = 0;
  for (let i = 0; i < size; i++) { acc += p[i]; cdf[i] = acc; }
  const counts = new Map();
  for (let s = 0; s < SHOTS; s++) {
    const r = Math.random() * acc; let lo = 0, hi = size - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
    counts.set(lo, (counts.get(lo) || 0) + 1);
  }
  renderCircuit(p1);
  const where = eng.kind === "gpu" ? "your GPU" : "your CPU";
  $("#run-info").innerHTML = `${steps.length} gate steps on ${where} in <b>${ms < 1 ? (ms * 1000).toFixed(0) + " µs" : ms.toFixed(2) + " ms"}</b> · state ${fmtBytes(size * (eng.kind === "gpu" ? 8 : 16))}`;
  renderHist(p, counts);
  renderBlochs(bloch);
  renderAmps(st, p);
}
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

function renderHist(p, counts) {
  const top = topOutcomes(p, 12).filter(([, v]) => v > 1e-9);
  const max = top[0]?.[1] || 1;
  $("#hist").innerHTML = top.map(([i, v]) => {
    const c = counts.get(i) || 0;
    return `<div class="hr"><span class="k">|${bits(i, n)}⟩</span><span class="bar"><i style="width:${(v / max) * 100}%"></i><s style="left:calc(${Math.min(100, (c / SHOTS / max) * 100)}% - 1px)"></s></span><span class="p">${(v * 100).toFixed(1)}%</span><span class="c">${c}</span></div>`;
  }).join("") + `<div class="legend"><span><i></i>exact probability</span><span><s></s>${SHOTS.toLocaleString()} sampled shots</span></div>`;
}

function blochSVG({ x, y, z }) {
  const R = 40, cx = 52, cy = 50;
  const px = (vx, vy, vz) => [cx + R * (vy * 0.95 - vx * 0.42), cy - R * (vz * 0.95 - vx * 0.28)];
  const [ex, ey] = px(x, y, z);
  const len = Math.hypot(x, y, z);
  return `<svg viewBox="0 0 104 100" aria-hidden="true">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="#fafaf9" stroke="#d6d6d4"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${R}" ry="${R * 0.3}" fill="none" stroke="#d6d6d4" stroke-dasharray="2 3"/>
    <line x1="${cx}" y1="${cy - R}" x2="${cx}" y2="${cy + R}" stroke="#d6d6d4"/>
    <text x="${cx}" y="${cy - R - 2}" font-size="8" fill="#9a9ca3" text-anchor="middle" font-family="JB Mono, monospace">|0⟩</text>
    <text x="${cx}" y="${cy + R + 9}" font-size="8" fill="#9a9ca3" text-anchor="middle" font-family="JB Mono, monospace">|1⟩</text>
    <line x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${len > 0.05 ? "#0c0d12" : "#c4c4c8"}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.4" fill="${len > 0.05 ? "#0c0d12" : "#c4c4c8"}"/>
    <circle cx="${cx}" cy="${cy}" r="2" fill="#5c5e66"/>
  </svg>`;
}
function renderBlochs(list) {
  $("#blochs").innerHTML = list.map((b, q) => ({ b, q })).reverse().map(({ b, q }) => {
    const r = Math.hypot(b.x, b.y, b.z);
    return `<div class="bl">${blochSVG(b)}<div class="lb">q${q} <em>${r < 0.98 ? `r ${r.toFixed(2)}` : "pure"}</em></div></div>`;
  }).join("");
}

function renderAmps(st, p) {
  const top = topOutcomes(p, 16).filter(([, v]) => v > 1e-9);
  $("#amps").innerHTML = top.map(([i]) => {
    const re = st.re[i], im = st.im[i], ph = Math.atan2(im, re);
    const ax = 11 + 8 * Math.cos(ph), ay = 11 - 8 * Math.sin(ph);
    return `<div class="ar"><span>|${bits(i, n)}⟩</span><span class="v">${fmt(re)} ${im < 0 ? "−" : "+"} ${fmt(Math.abs(im))}i</span><span class="pp">${(p[i] * 100).toFixed(1)}%</span>
      <svg viewBox="0 0 22 22" width="22" height="22" aria-label="phase"><circle cx="11" cy="11" r="9" fill="none" stroke="#d6d6d4"/><line x1="11" y1="11" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="#0c0d12" stroke-width="1.6" stroke-linecap="round"/></svg></div>`;
  }).join("") || `<p class="empty">No amplitudes.</p>`;
}

/* ══ Qubit Test ═════════════════════════════════════════════ */
let result = null;
$("#test-run").addEventListener("click", runTest);

async function runTest() {
  const btn = $("#test-run"), status = $("#test-status");
  btn.disabled = true; $("#submit-box").hidden = true; result = null;
  const eng = await ready;
  const ladder = $("#ladder");
  ladder.innerHTML = "";
  ["#s-q", "#s-g", "#s-c", "#s-n"].forEach((s) => { $(s).textContent = "–"; $(s).className = $(s).classList.contains("small") ? "small" : ""; });
  try {
    // 1. the server's check circuit
    status.textContent = "Fetching a check circuit from the server…";
    const ch = await (await fetch("/api/bench/challenge")).json();
    status.textContent = `Solving the ${CHECK_N}-qubit check circuit…`;
    await eng.run(CHECK_N, checkCircuit(ch.seed));
    const st = await eng.read();
    const p = st.re.map((r, i) => r * r + st.im[i] * st.im[i]);
    const top = topOutcomes(p).map(([i, v]) => [i, Math.round(v * 1e7) / 1e7]);
    $("#s-c").textContent = "solved, sent with result";
    // 2. the ladder
    const max = eng.maxQubits;
    const sizes = [];
    for (let k = 12; k <= max; k += 2) sizes.push(k);
    if (sizes[sizes.length - 1] !== max) sizes.push(max);
    const rungs = sizes.map((k) => {
      const el = document.createElement("div");
      el.className = "rung";
      el.innerHTML = `<span class="t">…</span><div class="col" style="height:3px"></div><span class="n">${k}q</span>`;
      ladder.append(el);
      return el;
    });
    let best = 0, bestN = 0, maxQ = 0, worst = 1;
    const times = [];
    for (let i = 0; i < sizes.length; i++) {
      const k = sizes[i], el = rungs[i];
      status.textContent = `Allocating ${k} qubits (${fmtBytes(8 * 2 ** k)})…`;
      if (!(await eng.tryAlloc(k))) { el.querySelector(".col").classList.add("fail"); el.querySelector(".t").textContent = "no room"; break; }
      const depth = k >= 26 ? 2 : 8;
      const steps = compile(randomCircuit(k, depth, 1000 + k));
      status.textContent = `Running ${k} qubits · ${steps.length} gate steps…`;
      let ms;
      try { ms = await eng.run(k, steps); } catch (e) { el.querySelector(".t").textContent = "failed"; break; }
      const g = (steps.length * 2 ** k) / ms / 1e6; // giga amplitude updates per second
      worst = await eng.norm(); // checked while this state is still on the GPU
      maxQ = k;
      if (k >= 16 && g > best) { best = g; bestN = k; }
      times.push(ms);
      const tmax = Math.max(...times);
      rungs.forEach((r, j) => { if (times[j] !== undefined) r.querySelector(".col").style.height = `${Math.max(3, (Math.log10(times[j] + 1) / Math.log10(tmax + 1)) * 180)}px`; });
      el.querySelector(".t").textContent = ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;
      $("#s-q").textContent = maxQ;
      if (best) $("#s-g").textContent = best.toFixed(best < 10 ? 2 : 1);
      if (ms > 12000) break; // the next size would take minutes
    }
    const okNorm = Math.abs(worst - 1) < 1e-3;
    $("#s-n").textContent = worst.toFixed(6);
    $("#s-n").className = `small ${okNorm ? "ok" : "bad"}`;
    eng.free?.();
    if (!best && maxQ) { best = 0; bestN = maxQ; }
    result = { id: ch.id, top, maxQ, gaups: best, bestN, backend: eng.kind === "gpu" ? "webgpu" : "cpu", gpu: eng.label, desc: eng.description };
    status.textContent = `Done. Your ${eng.kind === "gpu" ? "GPU" : "CPU"} held ${maxQ} qubits.`;
    $("#submit-box").hidden = false;
    $("#s-msg").textContent = "Timing is measured in your browser. Correctness is checked by the server.";
  } catch (e) {
    console.error(e);
    status.textContent = `The test stopped: ${e.message}`;
  }
  btn.disabled = false;
}

$("#s-send").addEventListener("click", async () => {
  if (!result) return;
  const btn = $("#s-send"); btn.disabled = true;
  const res = await fetch("/api/bench", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...result, name: $("#s-name").value }) });
  const j = await res.json().catch(() => ({}));
  if (res.ok) {
    $("#s-c").textContent = "verified by the server"; $("#s-c").className = "small ok";
    $("#s-msg").textContent = "On the board.";
    result = null;
    setTimeout(() => show("board"), 700);
  } else {
    $("#s-msg").textContent = j.error || "Could not submit.";
    if (res.status === 422) { $("#s-c").textContent = "did not match"; $("#s-c").className = "small bad"; }
  }
  btn.disabled = false;
});

/* ══ Leaderboard ════════════════════════════════════════════ */
async function loadBoard() {
  const box = $("#board");
  box.innerHTML = `<p class="empty">Loading…</p>`;
  let rows = [];
  try { rows = (await (await fetch("/api/leaderboard")).json()).rows || []; } catch { /* offline */ }
  const head = `<div class="tr head"><span>#</span><span>Name</span><span class="c-desc">GPU</span><span>Qubits</span><span>G updates/s</span><span class="c-back">Backend</span><span class="c-date">Date</span></div>`;
  if (!rows.length) { box.innerHTML = head + `<p class="empty">No runs yet. Run the Qubit Test and be the first on the board.</p>`; return; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  box.innerHTML = head + rows.map((r, i) => `<div class="tr"><span class="mono muted">${i + 1}</span><span>${esc(r.name || "anon")}</span><span class="c-desc mono">${esc(r.gpu)}</span><span class="big">${r.maxQ}</span><span class="mono">${r.gaups ? r.gaups.toFixed(2) : "–"}</span><span class="c-back"><span class="ver">${r.backend === "webgpu" ? "WebGPU" : "CPU"} · verified</span></span><span class="c-date mono muted">${r.at.slice(0, 10)}</span></div>`).join("");
}

/* boot */
renderPalette();
changed();
initLaunchpad(ready);
const initial = location.hash.slice(1);
if (["mine", "composer", "test", "board"].includes(initial)) show(initial);
