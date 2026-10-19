import { CIRCUITS, run, qubitsFor } from "./sim.js";

const CFG = window.HUBGPU_CONFIG || {};
const $ = (s) => document.querySelector(s);

/* hero machine: loads behind the text so the page is readable at once */
// the machine is framed between the header (and mobile readout) and the text at the bottom
const reserve = () => {
  const stats = document.querySelector(".hud-stats");
  // on phones the state readout sits under the header; on desktop it shares the bottom row
  const statsTop = stats && innerWidth <= 1023 ? stats.offsetTop + stats.offsetHeight : 0;
  return { top: Math.max($("#top").offsetHeight, statsTop), bottom: $(".hero-base").offsetHeight };
};
import("./scene.js").then((m) => m.mountScene($("#panel"), { reserve })).catch((e) => {
  console.warn("scene", e);
  $("#panel").classList.add("no-webgl");
});

/* header turns light once the machine scrolls away */
const top = $("#top"), hero = $("#hero");
const onScroll = () => top.classList.toggle("light", scrollY > hero.offsetHeight - 70);
addEventListener("scroll", onScroll, { passive: true }); onScroll();

/* real numbers from the launchpad and the qubit test; the strip stays hidden until something has happened */
fetch("/api/stats").then((r) => r.json()).then((s) => {
  if (!s.born && !s.runs) return;
  const usd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`);
  const cells = [[s.born, "Tokens born"], [s.mcap ? usd(s.mcap) : "–", "Market cap of born tokens"], [s.gpus, "GPUs on the board"], [s.maxQubits || "–", "Most qubits held"]];
  const el = $("#stats");
  el.innerHTML = cells.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
  el.hidden = false;
}).catch(() => {});

/* reveals */
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
}), { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
document.querySelectorAll(".reveal").forEach((el, i) => { el.style.transitionDelay = `${(i % 4) * 70}ms`; io.observe(el); });

/* token + socials */
const copy = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* in-app wallets block it */ }
  const t = Object.assign(document.createElement("textarea"), { value: text });
  t.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  document.body.append(t); t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* nothing left */ }
  t.remove();
  return ok;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
if (CFG.ticker) { $("#foot-ticker").textContent = CFG.ticker; $("#band-ticker").textContent = CFG.ticker; }
if (CFG.ca) {
  // the full address on wide screens, like every other launch site of ours
  const fit = () => { $("#ca .ca-val").textContent = innerWidth > 900 ? CFG.ca : short(CFG.ca); };
  fit(); addEventListener("resize", fit);
  $("#foot-ca").textContent = short(CFG.ca);
  for (const el of [$("#ca"), $("#foot-ca")]) el.addEventListener("click", async () => {
    if (!(await copy(CFG.ca))) return;
    $("#ca").classList.add("copied");
    setTimeout(() => $("#ca").classList.remove("copied"), 1400);
  });
} else {
  $("#ca").style.cursor = "default";
}
const social = $("#foot-social");
if (CFG.x) { $("#nav-x").href = CFG.x; $("#nav-x").hidden = false; social.insertAdjacentHTML("beforeend", `<a href="${CFG.x}" target="_blank" rel="noopener">X</a>`); }
if (CFG.telegram) social.insertAdjacentHTML("beforeend", `<a href="${CFG.telegram}" target="_blank" rel="noopener">Telegram</a>`);
if (!CFG.x && !CFG.telegram) social.insertAdjacentHTML("beforeend", `<span style="color:var(--ink-faint)">Soon</span>`);
if (CFG.buyUrl) $("#foot-ca").insertAdjacentHTML("afterend", `<a href="${CFG.buyUrl}" target="_blank" rel="noopener">Buy ${CFG.ticker}</a>`);

/* qubits per card: computed from each card's memory */
const CARDS = [
  ["RTX 4090", 24], ["RTX 5090", 32], ["A100", 80], ["H100", 80], ["H200", 141], ["B200", 192],
];
const maxQ = qubitsFor(192);
$("#qtable").innerHTML = `<div class="qrow head"><span>Card</span><span>VRAM</span><span>Qubits</span><span class="qh-bar">Statevector ceiling</span></div>` +
  CARDS.map(([n, g]) => {
    const q = qubitsFor(g);
    return `<div class="qrow"><span>${n}</span><span class="mono">${g} GB</span><span class="qn">${q}</span><span class="qbar"><i style="--w:${((q - 20) / (maxQ - 20)) * 100}%"></i></span></div>`;
  }).join("");
const vr = $("#vram");
const setRange = (el) => el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
const onVram = () => {
  // log scale feels right here: 1 GiB to 1 TiB
  const gib = Math.round(2 ** ((vr.value / vr.max) * 10));
  $("#vram-g").textContent = gib.toLocaleString();
  $("#vram-q").textContent = qubitsFor(gib);
  setRange(vr);
};
vr.value = Math.round((Math.log2(80) / 10) * vr.max);
vr.addEventListener("input", onVram); onVram();

/* simulator */
let current = "bell";
const tabs = $("#sim-tabs");
tabs.innerHTML = Object.entries(CIRCUITS).map(([k, c]) => `<button type="button" role="tab" data-k="${k}" aria-selected="${k === current}">${c.name}</button>`).join("");
const qs = $("#sim-qubits");
const build = () => (current === "random" ? CIRCUITS.random.build(+qs.value, 10) : CIRCUITS[current].build());

function drawCircuit({ n, ops }) {
  // compact columns: a gate goes in the first column where its wires are free
  const cols = [];
  const free = new Array(n).fill(0);
  for (const op of ops) {
    const wires = op[0] === "oracle" ? [...Array(n).keys()] : op[0] === "cx" || op[0] === "cz" ? [Math.min(op[1], op[2]), Math.max(op[1], op[2])] : [op[1]];
    const lo = Math.min(...wires), hi = Math.max(...wires);
    let c = 0;
    for (let w = lo; w <= hi; w++) c = Math.max(c, free[w]);
    for (let w = lo; w <= hi; w++) free[w] = c + 1;
    (cols[c] ||= []).push(op);
  }
  const MAXC = 44, shown = cols.slice(0, MAXC);
  const rowH = n > 12 ? 14 : n > 6 ? 20 : 30, colW = 34, x0 = 46, y0 = 16;
  const W = x0 + shown.length * colW + 30, H = y0 * 2 + (n - 1) * rowH;
  const y = (q) => y0 + (n - 1 - q) * rowH;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" style="max-width:100%;min-width:${Math.min(W, 520)}px" font-family="JB Mono, monospace">`;
  for (let q = 0; q < n; q++) {
    s += `<line x1="${x0 - 8}" x2="${W - 10}" y1="${y(q)}" y2="${y(q)}" stroke="#0c0d1230"/>`;
    if (n <= 12 || q % 2 === 0) s += `<text x="4" y="${y(q) + 4}" font-size="${rowH < 20 ? 8 : 10}" fill="#0c0d1288">q${q}</text>`;
  }
  const box = Math.min(22, rowH - 4);
  shown.forEach((col, ci) => {
    const cx = x0 + ci * colW + colW / 2;
    for (const op of col) {
      const [g, a, b] = op;
      if (g === "cx" || g === "cz") {
        s += `<line x1="${cx}" x2="${cx}" y1="${y(a)}" y2="${y(b)}" stroke="#0c0d12" stroke-width="1.4"/>`;
        s += `<circle cx="${cx}" cy="${y(a)}" r="3.4" fill="#0c0d12"/>`;
        s += g === "cx" ? `<circle cx="${cx}" cy="${y(b)}" r="7" fill="#fff" stroke="#0c0d12" stroke-width="1.4"/><path d="M${cx - 7} ${y(b)}h14M${cx} ${y(b) - 7}v14" stroke="#0c0d12" stroke-width="1.4"/>` : `<circle cx="${cx}" cy="${y(b)}" r="3.4" fill="#0c0d12"/>`;
      } else if (g === "oracle") {
        const top = y(n - 1) - box / 2, bot = y(0) + box / 2;
        s += `<rect x="${cx - 12}" y="${top}" width="24" height="${bot - top}" rx="5" fill="#0c0d12"/><text x="${cx}" y="${(top + bot) / 2 + 4}" font-size="10" fill="#fff" text-anchor="middle">${a ? "O" : "D"}</text>`;
      } else {
        const label = { h: "H", x: "X", sx: "√X", ry: "Ry", rz: "Rz" }[g];
        s += `<rect x="${cx - box / 2 - 2}" y="${y(a) - box / 2}" width="${box + 4}" height="${box}" rx="4" fill="${g === "h" ? "#0c0d12" : "#ffffff"}" stroke="${g === "h" ? "none" : "#0c0d1233"}"/>`;
        if (box >= 12) s += `<text x="${cx}" y="${y(a) + 3.5}" font-size="${box < 18 ? 7 : 10}" fill="${g === "h" ? "#fff" : "#0c0d12"}" text-anchor="middle">${label}</text>`;
      }
    }
  });
  if (cols.length > MAXC) s += `<text x="${W - 26}" y="${H / 2 + 4}" font-size="12" fill="#0c0d1288">…</text>`;
  s += `</svg>`;
  $("#sim-circuit").innerHTML = s;
}

function fmtBytes(b) {
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

function select(k) {
  current = k;
  tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", b.dataset.k === k));
  $("#sim-blurb").textContent = CIRCUITS[k].blurb;
  $("#sim-n").hidden = k !== "random";
  const c = build();
  drawCircuit(c);
  $("#st-n").textContent = c.n;
  $("#st-g").textContent = c.ops.length;
  $("#st-b").textContent = fmtBytes((1 << c.n) * 16);
  $("#st-t").textContent = "–";
  $("#sim-hist").innerHTML = `<p class="sim-empty">Press run to sample the circuit.</p>`;
}
tabs.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) select(b.dataset.k); });
qs.addEventListener("input", () => { $("#sim-qv").textContent = qs.value; setRange(qs); select("random"); });
setRange(qs);

$("#sim-run").addEventListener("click", async () => {
  const btn = $("#sim-run");
  btn.disabled = true; btn.style.opacity = 0.6;
  await new Promise((r) => setTimeout(r, 30));
  const c = build();
  const SHOTS = 2048;
  const res = run(c, SHOTS);
  btn.disabled = false; btn.style.opacity = "";
  $("#st-t").textContent = res.ms < 1 ? `${(res.ms * 1000).toFixed(0)} µs` : `${res.ms.toFixed(res.ms < 10 ? 2 : 0)} ms`;
  const rows = [...res.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const top = rows[0]?.[1] || 1;
  const bits = (i) => i.toString(2).padStart(c.n, "0");
  const html = rows.map(([i, n]) =>
    `<div class="hrow"><span>|${bits(i)}⟩</span><span class="bar"><i class="${c.target === i ? "hit" : ""}" data-w="${(n / top) * 100}"></i></span><span class="pc">${((n / SHOTS) * 100).toFixed(1)}%</span></div>`).join("");
  const distinct = res.counts.size;
  const note = c.target !== undefined
    ? `Exact probability of the marked state |${bits(c.target)}⟩: ${(res.p[c.target] * 100).toFixed(2)}%.`
    : `${distinct.toLocaleString()} distinct outcomes in ${SHOTS.toLocaleString()} shots${distinct > rows.length ? `, top ${rows.length} shown` : ""}.`;
  $("#sim-hist").innerHTML = html + `<p class="hnote">${note}</p>`;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelectorAll(".hrow .bar i").forEach((el) => { el.style.width = el.dataset.w + "%"; });
  }));
});
select(current);

/* band: slow interference fringes, two point sources */
(function band() {
  const cv = $("#band-cv");
  if (!cv) return;
  const g = cv.getContext("2d");
  let w = 0, h = 0, dpr = Math.min(2, devicePixelRatio || 1), vis = false, raf = 0;
  const fit = () => {
    w = cv.clientWidth; h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + "px"; cv.style.height = h + "px";
  };
  const frame = (ts) => {
    raf = 0;
    const t = ts / 1000;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const s1 = [w * 0.72, h * (0.5 + Math.sin(t * 0.3) * 0.12)], s2 = [w * 0.86, h * (0.5 - Math.sin(t * 0.3) * 0.12)];
    const step = 9;
    for (let y = 0; y < h; y += step) for (let x = w * 0.35; x < w; x += step) {
      const d1 = Math.hypot(x - s1[0], y - s1[1]), d2 = Math.hypot(x - s2[0], y - s2[1]);
      const a = Math.cos(d1 * 0.06 - t * 1.6) + Math.cos(d2 * 0.06 - t * 1.6);
      const v = (a * a) / 4;
      if (v < 0.25) continue;
      const fade = Math.min(1, (x - w * 0.35) / (w * 0.25));
      g.fillStyle = `rgba(12,13,18,${v * 0.22 * fade})`;
      g.fillRect(x, y, 1.6, 1.6);
    }
    if (vis) raf = requestAnimationFrame(frame);
  };
  new ResizeObserver(fit).observe(cv); fit();
  new IntersectionObserver(([e]) => { vis = e.isIntersecting; if (vis && !raf) raf = requestAnimationFrame(frame); }).observe(cv);
})();
