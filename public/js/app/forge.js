// The Forge: a token is born from one measurement. The creator's GPU runs a random circuit seeded by the name,
// ticker and a fresh nonce, the state is sampled once, and the outcome plus the shape of the distribution are
// drawn as the token's seal: an 8×8 field of porcelain tiles, the same language as the machine on the home page.
// $HGPU holders can birth from 16 qubits instead: a 16×16 seal on a black porcelain plate (the rare seal).
import { compile, randomCircuit } from "./gates.js";

const CFG = window.HUBGPU_CONFIG;

/** FNV-1a over a string, folded to a positive 31-bit seed */
function hash31(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 0) % 2147483646) + 1;
}

/**
 * Run the birth circuit and measure it once.
 * → { seed, n, bits, index, p, cells[64], ms, steps, backend }
 */
export async function measureBirth(engine, name, symbol, { rare = false } = {}) {
  const n = rare ? 16 : CFG.launch.qubits, depth = CFG.launch.depth;
  const nonce = crypto.getRandomValues(new Uint32Array(2)).join("-");
  const seed = hash31(`${name}|${symbol}|${nonce}`);
  const steps = compile(randomCircuit(n, depth, seed));
  const ms = await engine.run(n, steps);
  const st = await engine.read();
  const size = 1 << n, p = new Float64Array(size);
  let acc = 0;
  for (let i = 0; i < size; i++) { p[i] = st.re[i] * st.re[i] + st.im[i] * st.im[i]; acc += p[i]; }
  // one shot, drawn with the browser's cryptographic randomness
  const r = (crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * acc;
  let index = size - 1, run = 0;
  for (let i = 0; i < size; i++) { run += p[i]; if (run >= r) { index = i; break; } }
  // the seal: buckets of the distribution (top 6 qubits → 8×8, or top 8 → 16×16), each tile's tone from its share
  const side = rare ? 16 : 8, top = rare ? 8 : 6;
  const cells = new Array(side * side).fill(0);
  const shift = n - top;
  for (let i = 0; i < size; i++) cells[i >> shift] += p[i];
  return { seed, n, rare, side, bits: index.toString(2).padStart(n, "0"), index, p: p[index], cells, cell: index >> shift, ms, steps: steps.length, backend: engine.kind };
}

/** Draw the seal for a measurement onto a square canvas. */
export function drawSeal(cv, m, size = 1000) {
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  const s = size / 1000, side = m.side || 8, rare = !!m.rare;
  // paper
  const bg = g.createRadialGradient(500 * s, 420 * s, 80 * s, 500 * s, 500 * s, 760 * s);
  bg.addColorStop(0, "#ffffff"); bg.addColorStop(1, "#ececea");
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  // the plate the tiles sit in: white porcelain, or black for a rare birth
  const P0 = 150 * s, PW = 700 * s;
  g.save();
  g.shadowColor = rare ? "rgba(0,0,0,0.32)" : "rgba(0,0,0,0.16)"; g.shadowBlur = 40 * s; g.shadowOffsetY = 18 * s;
  rr(g, P0, P0, PW, PW, 56 * s);
  const plate = g.createLinearGradient(P0, P0, P0 + PW, P0 + PW);
  if (rare) { plate.addColorStop(0, "#2a2a2d"); plate.addColorStop(1, "#08080a"); } else { plate.addColorStop(0, "#f6f6f4"); plate.addColorStop(1, "#f6f6f4"); }
  g.fillStyle = plate; g.fill();
  g.restore();
  g.save(); rr(g, P0, P0, PW, PW, 56 * s); g.clip();
  const inner = g.createLinearGradient(0, P0, 0, P0 + PW);
  inner.addColorStop(0, rare ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.05)"); inner.addColorStop(0.15, "rgba(0,0,0,0)"); inner.addColorStop(1, rare ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.6)");
  g.fillStyle = inner; g.fillRect(P0, P0, PW, PW);
  g.restore();
  // tiles: rank the buckets; the most likely take the strong tone, the next grey, the rest the plate's own tone, raised
  const total = side * side;
  const order = m.cells.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  const rank = new Array(total); order.forEach((i, r) => (rank[i] = r));
  const strongN = Math.round(total * 0.16), greyN = Math.round(total * 0.38);
  const pad = (side > 8 ? 40 : 46) * s, gap = (side > 8 ? 7 : 14) * s, cell = (PW - 2 * pad - (side - 1) * gap) / side, rad = (side > 8 ? 6 : 14) * s;
  for (let i = 0; i < total; i++) {
    const cx = i % side, cy = (i / side) | 0;
    const x = P0 + pad + cx * (cell + gap), y = P0 + pad + cy * (cell + gap);
    const tone = rank[i] < strongN ? "strong" : rank[i] < greyN ? "grey" : "base";
    const dark = rare ? tone !== "strong" && tone !== "grey" : tone === "strong";   // on the black plate the likely tiles turn white
    const lift = tone === "base" ? 1 : tone === "grey" ? 0.7 : 0.45;
    g.save();
    g.shadowColor = rare ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.22)"; g.shadowBlur = (side > 8 ? 7 : 14) * s * lift; g.shadowOffsetX = (side > 8 ? 2 : 4) * s * lift; g.shadowOffsetY = (side > 8 ? 4 : 8) * s * lift;
    rr(g, x, y, cell, cell, rad);
    const f = g.createLinearGradient(x, y, x + cell, y + cell);
    if (tone === "grey") { if (rare) { f.addColorStop(0, "#6c6c70"); f.addColorStop(1, "#3c3c40"); } else { f.addColorStop(0, "#cfcfcd"); f.addColorStop(1, "#9c9c9a"); } }
    else if (dark) { f.addColorStop(0, "#3a3a3d"); f.addColorStop(0.45, "#121214"); f.addColorStop(1, "#050506"); }
    else { f.addColorStop(0, "#ffffff"); f.addColorStop(1, "#e6e6e4"); }
    g.fillStyle = f; g.fill();
    g.restore();
    g.save(); rr(g, x, y, cell, cell, rad); g.clip();
    const hl = g.createLinearGradient(x, y, x, y + cell * 0.6);
    hl.addColorStop(0, dark ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.9)"); hl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = hl; g.fillRect(x, y, cell, cell * 0.6);
    g.restore();
    if (i === m.cell) {
      // where the measurement landed: a ring in the opposite tone
      g.beginPath(); g.arc(x + cell / 2, y + cell / 2, cell * (side > 8 ? 0.26 : 0.2), 0, Math.PI * 2);
      g.lineWidth = (side > 8 ? 4 : 7) * s; g.strokeStyle = dark ? "#ffffff" : "#0c0d12"; g.stroke();
    }
  }
  return cv;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export const groupBits = (b) => b.replace(/(.{4})/g, "$1 ").trim();
