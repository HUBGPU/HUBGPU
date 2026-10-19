// Gate definitions shared by the WebGPU engine, the CPU engine and the server's
// benchmark check. No DOM here, so Node can import it too.

const S = Math.SQRT1_2;
const c = (re, im = 0) => [re, im];

// 2x2 unitaries as [a, b, c, d], each a complex [re, im]: |0'> = a|0> + b|1>, |1'> = c|0> + d|1>
export function matrix(g, theta = Math.PI / 2) {
  const h = theta / 2, co = Math.cos(h), si = Math.sin(h);
  switch (g) {
    case "h": return [c(S), c(S), c(S), c(-S)];
    case "x": return [c(0), c(1), c(1), c(0)];
    case "y": return [c(0), c(0, -1), c(0, 1), c(0)];
    case "z": return [c(1), c(0), c(0), c(-1)];
    case "s": return [c(1), c(0), c(0), c(0, 1)];
    case "t": return [c(1), c(0), c(0), c(S, S)];
    case "sx": return [c(0.5, 0.5), c(0.5, -0.5), c(0.5, -0.5), c(0.5, 0.5)];
    case "rx": return [c(co), c(0, -si), c(0, -si), c(co)];
    case "ry": return [c(co), c(-si), c(si), c(co)];
    case "rz": return [c(co, -si), c(0), c(0), c(co, si)];
    default: throw new Error(`unknown gate ${g}`);
  }
}

export const GATES = {
  h: { label: "H", name: "Hadamard", kind: 1, tip: "Puts a qubit into an equal superposition." },
  x: { label: "X", name: "Pauli-X", kind: 1, tip: "Flips |0⟩ and |1⟩. The quantum NOT." },
  y: { label: "Y", name: "Pauli-Y", kind: 1, tip: "A flip with a phase of i." },
  z: { label: "Z", name: "Pauli-Z", kind: 1, tip: "Flips the sign of |1⟩." },
  s: { label: "S", name: "Phase S", kind: 1, tip: "Quarter turn of phase on |1⟩." },
  t: { label: "T", name: "Phase T", kind: 1, tip: "Eighth turn of phase on |1⟩." },
  rx: { label: "Rx", name: "Rotate X", kind: 1, angle: true, tip: "Rotates around the X axis of the Bloch sphere." },
  ry: { label: "Ry", name: "Rotate Y", kind: 1, angle: true, tip: "Rotates around the Y axis." },
  rz: { label: "Rz", name: "Rotate Z", kind: 1, angle: true, tip: "Rotates around the Z axis." },
  cx: { label: "CX", name: "CNOT", kind: 2, tip: "Flips the target when the control is |1⟩. Makes entanglement." },
  cz: { label: "CZ", name: "Controlled-Z", kind: 2, tip: "Flips the sign when both qubits are |1⟩." },
  swap: { label: "SW", name: "Swap", kind: 2, tip: "Exchanges two qubits." },
};

/**
 * Lower circuit ops to primitive steps { t, cmask, m } that both engines run.
 * ops: { g, q, q2?, theta? } — for two-qubit gates q is the control, q2 the target.
 */
export function compile(ops) {
  const out = [];
  const flat = (m) => m.flat();
  for (const op of ops) {
    if (op.g === "cx") out.push({ t: op.q2, cmask: 1 << op.q, m: flat(matrix("x")) });
    else if (op.g === "cz") out.push({ t: op.q2, cmask: 1 << op.q, m: flat(matrix("z")) });
    else if (op.g === "swap") {
      const X = flat(matrix("x"));
      out.push({ t: op.q2, cmask: 1 << op.q, m: X }, { t: op.q, cmask: 1 << op.q2, m: X }, { t: op.q2, cmask: 1 << op.q, m: X });
    } else out.push({ t: op.q, cmask: 0, m: flat(matrix(op.g, op.theta)) });
  }
  return out;
}

/** A seeded random circuit: layers of single-qubit rotations and CZ couplers. */
export function randomCircuit(n, depth, seed = 1) {
  let s = (seed >>> 0) % 2147483647 || 1;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const ops = [];
  for (let q = 0; q < n; q++) ops.push({ g: "h", q });
  for (let d = 0; d < depth; d++) {
    for (let q = 0; q < n; q++) {
      const g = ["rx", "ry", "rz", "sx", "t"][Math.floor(r() * 5)];
      ops.push({ g, q, theta: r() * Math.PI * 2 });
    }
    for (let q = d % 2; q + 1 < n; q += 2) ops.push({ g: "cz", q, q2: q + 1 });
  }
  return ops;
}

/** Exact CPU statevector, float64. Returns { re, im }. */
export function cpuRun(n, steps) {
  const size = 1 << n, re = new Float64Array(size), im = new Float64Array(size);
  re[0] = 1;
  for (const { t, cmask, m } of steps) {
    const bit = 1 << t;
    const [ar, ai, br, bi, cr, ci, dr, di] = m;
    for (let i = 0; i < size; i++) {
      if (i & bit || (i & cmask) !== cmask) continue;
      const j = i | bit;
      const xr = re[i], xi = im[i], yr = re[j], yi = im[j];
      re[i] = ar * xr - ai * xi + br * yr - bi * yi;
      im[i] = ar * xi + ai * xr + br * yi + bi * yr;
      re[j] = cr * xr - ci * xi + dr * yr - di * yi;
      im[j] = cr * xi + ci * xr + dr * yi + di * yr;
    }
  }
  return { re, im };
}

// The benchmark's correctness check: a 14-qubit circuit from a server-issued seed.
export const CHECK_N = 14, CHECK_DEPTH = 12;
export function checkCircuit(seed) { return compile(randomCircuit(CHECK_N, CHECK_DEPTH, seed)); }
/** The 16 most likely outcomes as [index, probability] pairs. */
export function topOutcomes(probs, k = 16) {
  const idx = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]).slice(0, k);
  return idx.map((i) => [i, probs[i]]);
}
