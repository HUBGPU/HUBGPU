// A small, exact statevector simulator. Everything the "Simulate" section shows
// is computed here, in the visitor's browser: amplitudes, probabilities, shots, timing.

export class State {
  constructor(n) {
    this.n = n;
    this.size = 1 << n;
    this.re = new Float64Array(this.size);
    this.im = new Float64Array(this.size);
    this.re[0] = 1;
  }
  // apply a 2x2 unitary [[a,b],[c,d]] (complex, as [re,im]) to qubit q
  u1(q, a, b, c, d) {
    const { re, im, size } = this, bit = 1 << q;
    for (let i = 0; i < size; i++) {
      if (i & bit) continue;
      const j = i | bit;
      const xr = re[i], xi = im[i], yr = re[j], yi = im[j];
      re[i] = a[0] * xr - a[1] * xi + b[0] * yr - b[1] * yi;
      im[i] = a[0] * xi + a[1] * xr + b[0] * yi + b[1] * yr;
      re[j] = c[0] * xr - c[1] * xi + d[0] * yr - d[1] * yi;
      im[j] = c[0] * xi + c[1] * xr + d[0] * yi + d[1] * yr;
    }
  }
  h(q) { const s = Math.SQRT1_2; this.u1(q, [s, 0], [s, 0], [s, 0], [-s, 0]); }
  x(q) { this.u1(q, [0, 0], [1, 0], [1, 0], [0, 0]); }
  rz(q, t) { this.u1(q, [Math.cos(-t / 2), Math.sin(-t / 2)], [0, 0], [0, 0], [Math.cos(t / 2), Math.sin(t / 2)]); }
  ry(q, t) { const c = Math.cos(t / 2), s = Math.sin(t / 2); this.u1(q, [c, 0], [-s, 0], [s, 0], [c, 0]); }
  sx(q) { this.u1(q, [0.5, 0.5], [0.5, -0.5], [0.5, -0.5], [0.5, 0.5]); }
  cx(c, t) {
    const { re, im, size } = this, cb = 1 << c, tb = 1 << t;
    for (let i = 0; i < size; i++) {
      if (!(i & cb) || (i & tb)) continue;
      const j = i | tb;
      let v = re[i]; re[i] = re[j]; re[j] = v;
      v = im[i]; im[i] = im[j]; im[j] = v;
    }
  }
  cz(a, b) {
    const { re, im, size } = this, m = (1 << a) | (1 << b);
    for (let i = 0; i < size; i++) if ((i & m) === m) { re[i] = -re[i]; im[i] = -im[i]; }
  }
  // flip the sign of one basis state (Grover oracle)
  mark(k) { this.re[k] = -this.re[k]; this.im[k] = -this.im[k]; }
  probs() {
    const p = new Float64Array(this.size);
    for (let i = 0; i < this.size; i++) p[i] = this.re[i] * this.re[i] + this.im[i] * this.im[i];
    return p;
  }
}

/** Draw `shots` samples from a probability vector, returned as {index: count}. */
export function sample(p, shots) {
  const cdf = new Float64Array(p.length);
  let acc = 0;
  for (let i = 0; i < p.length; i++) { acc += p[i]; cdf[i] = acc; }
  const counts = new Map();
  for (let s = 0; s < shots; s++) {
    const r = Math.random() * acc;
    let lo = 0, hi = p.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
    counts.set(lo, (counts.get(lo) || 0) + 1);
  }
  return counts;
}

// circuits: each returns { n, ops } where ops drive both the simulator and the diagram
export const CIRCUITS = {
  bell: {
    name: "Bell pair", blurb: "Two qubits, one Hadamard, one CNOT. Measure one and you know the other: only 00 and 11 ever come out.",
    build: () => ({ n: 2, ops: [["h", 0], ["cx", 0, 1]] }),
  },
  ghz: {
    name: "GHZ · 6", blurb: "Six qubits entangled in a chain. Every shot reads all zeros or all ones, never anything in between.",
    build: () => { const ops = [["h", 0]]; for (let i = 0; i < 5; i++) ops.push(["cx", i, i + 1]); return { n: 6, ops }; },
  },
  grover: {
    name: "Grover · 4", blurb: "Search 16 answers for the marked one, 1011, in three rounds instead of sixteen tries. Watch it climb to about 96%.",
    build: () => {
      const n = 4, target = 0b1011, ops = [];
      for (let q = 0; q < n; q++) ops.push(["h", q]);
      for (let r = 0; r < 3; r++) {
        ops.push(["oracle", target]);
        for (let q = 0; q < n; q++) ops.push(["h", q]);
        ops.push(["oracle", 0]);
        for (let q = 0; q < n; q++) ops.push(["h", q]);
      }
      return { n, ops, target };
    },
  },
  random: {
    name: "Random · n", blurb: "Layers of random rotations and CZ couplers: the kind of circuit used to stress-test quantum hardware. Raise n and the work doubles per qubit.",
    build: (n = 12, depth = 10) => {
      const ops = [];
      let s = 99;
      const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let q = 0; q < n; q++) ops.push(["h", q]);
      for (let d = 0; d < depth; d++) {
        for (let q = 0; q < n; q++) ops.push([["sx", "ry", "rz"][Math.floor(r() * 3)], q, r() * Math.PI * 2]);
        for (let q = d % 2; q + 1 < n; q += 2) ops.push(["cz", q, q + 1]);
      }
      return { n, ops };
    },
  },
};

export function run({ n, ops }, shots = 2048) {
  const t0 = performance.now();
  const st = new State(n);
  for (const op of ops) {
    const [g, a, b] = op;
    if (g === "cx") st.cx(a, b);
    else if (g === "cz") st.cz(a, b);
    else if (g === "oracle") st.mark(a);
    else if (g === "ry" || g === "rz") st[g](a, b);
    else st[g](a);
  }
  const p = st.probs();
  const ms = performance.now() - t0;
  return { p, counts: sample(p, shots), ms, bytes: st.size * 16, gates: ops.length };
}

/** The largest statevector that fits in `gib` GiB at complex64 (8 bytes per amplitude). */
export const qubitsFor = (gib) => Math.floor(Math.log2((gib * 2 ** 30) / 8));
