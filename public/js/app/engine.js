// The statevector on the visitor's GPU. One compute dispatch per gate step;
// every step's parameters live in one uniform buffer, picked by dynamic offset.
import { cpuRun } from "./gates.js";

const WGSL = /* wgsl */`
struct P { n: u32, t: u32, cmask: u32, stride: u32, m0: vec4<f32>, m1: vec4<f32> };
@group(0) @binding(0) var<storage, read_write> s: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> p: P;
fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
@compute @workgroup_size(256)
fn gate(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = g.x + g.y * p.stride;
  if (k >= (1u << (p.n - 1u))) { return; }
  let low = (1u << p.t) - 1u;
  let i = ((k & ~low) << 1u) | (k & low);
  if ((i & p.cmask) != p.cmask) { return; }
  let j = i | (1u << p.t);
  let x = s[i];
  let y = s[j];
  s[i] = cmul(p.m0.xy, x) + cmul(p.m0.zw, y);
  s[j] = cmul(p.m1.xy, x) + cmul(p.m1.zw, y);
}
`;

const NORM_WGSL = /* wgsl */`
struct P { n: u32, t: u32, cmask: u32, stride: u32, m0: vec4<f32>, m1: vec4<f32> };
@group(0) @binding(0) var<storage, read_write> s: array<vec2<f32>>;
@group(0) @binding(1) var<uniform> p: P;
@group(0) @binding(2) var<storage, read_write> partial: array<f32>;
var<workgroup> acc: array<f32, 256>;
@compute @workgroup_size(256)
fn norm(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  let k = g.x + g.y * p.stride;
  var v = 0.0;
  if (k < (1u << p.n)) { let a = s[k]; v = dot(a, a); }
  acc[li] = v;
  workgroupBarrier();
  var w = 128u;
  loop {
    if (w == 0u) { break; }
    if (li < w) { acc[li] = acc[li] + acc[li + w]; }
    workgroupBarrier();
    w = w >> 1u;
  }
  if (li == 0u) { partial[wg.x + wg.y * (p.stride / 256u)] = acc[0]; }
}
`;

const SLOT = 256;           // dynamic-offset alignment
const BATCH = 2048;         // gate steps per uniform upload

export async function createGPU() {
  if (!navigator.gpu) return null;
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }); } catch { return null; }
  if (!adapter) return null;
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxComputeWorkgroupsPerDimension: L.maxComputeWorkgroupsPerDimension,
    },
  });
  const info = adapter.info || {};
  return new GPUEngine(device, info);
}

class GPUEngine {
  constructor(device, info) {
    this.kind = "gpu";
    this.device = device;
    this.info = info;
    this.label = [info.vendor, info.architecture].filter(Boolean).join(" · ") || "WebGPU device";
    this.description = info.description || info.device || "";
    const lim = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
    this.maxQubits = Math.min(30, Math.floor(Math.log2(lim / 8)));
    const module = device.createShaderModule({ code: WGSL });
    const normModule = device.createShaderModule({ code: NORM_WGSL });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 48 } },
      ],
    });
    this.normLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 48 } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.pipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: "gate" } });
    this.normPipe = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [this.normLayout] }), compute: { module: normModule, entryPoint: "norm" } });
    this.uni = device.createBuffer({ size: SLOT * BATCH, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.state = null; this.n = 0;
  }

  dims(threads) {
    const groups = Math.ceil(threads / 256);
    const dx = Math.min(groups, 32768);
    return { dx, dy: Math.ceil(groups / dx), stride: dx * 256 };
  }

  alloc(n) {
    if (n > this.maxQubits) throw new Error(`This GPU can hold at most ${this.maxQubits} qubits.`);
    if (this.state && this.n === n) return;
    this.state?.destroy();
    this.state = this.device.createBuffer({ size: 8 * 2 ** n, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.n = n;
    this.bind = this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.state } }, { binding: 1, resource: { buffer: this.uni, size: 48 } }] });
  }

  /** Reset to |0…0> and apply the steps. Resolves when the GPU has finished. */
  async run(n, steps) {
    const dev = this.device;
    this.alloc(n);
    const reset = dev.createCommandEncoder();
    reset.clearBuffer(this.state);
    dev.queue.submit([reset.finish()]);
    dev.queue.writeBuffer(this.state, 0, new Float32Array([1, 0]));
    const { dx, dy, stride } = this.dims(2 ** (n - 1));
    const t0 = performance.now();
    for (let off = 0; off < steps.length; off += BATCH) {
      const chunk = steps.slice(off, off + BATCH);
      const buf = new ArrayBuffer(SLOT * chunk.length);
      chunk.forEach((st, i) => {
        const u = new Uint32Array(buf, i * SLOT, 4), f = new Float32Array(buf, i * SLOT + 16, 8);
        u[0] = n; u[1] = st.t; u[2] = st.cmask; u[3] = stride;
        f.set(st.m);
      });
      dev.queue.writeBuffer(this.uni, 0, buf);
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipe);
      for (let i = 0; i < chunk.length; i++) {
        pass.setBindGroup(0, this.bind, [i * SLOT]);
        pass.dispatchWorkgroups(dx, dy);
      }
      pass.end();
      dev.queue.submit([enc.finish()]);
      if (off + BATCH < steps.length) await dev.queue.onSubmittedWorkDone(); // the uniform buffer is reused
    }
    await dev.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  }

  /** Copy the whole state back as { re, im } (only for small n). */
  async read() {
    const size = 8 * 2 ** this.n;
    const rb = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.state, 0, rb, 0, size);
    this.device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap(); rb.destroy();
    const len = 2 ** this.n, re = new Float64Array(len), im = new Float64Array(len);
    for (let i = 0; i < len; i++) { re[i] = f[2 * i]; im[i] = f[2 * i + 1]; }
    return { re, im };
  }

  /** Sum of |amplitude|^2 over the state, reduced on the GPU. Should be 1. */
  async norm() {
    const dev = this.device, len = 2 ** this.n;
    const { dx, dy, stride } = this.dims(len);
    const groups = dx * dy;
    const partial = dev.createBuffer({ size: 4 * groups, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = dev.createBuffer({ size: 4 * groups, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const u = new ArrayBuffer(48); new Uint32Array(u, 0, 4).set([this.n, 0, 0, stride]);
    dev.queue.writeBuffer(this.uni, 0, u);
    const bind = dev.createBindGroup({ layout: this.normLayout, entries: [
      { binding: 0, resource: { buffer: this.state } }, { binding: 1, resource: { buffer: this.uni, size: 48 } }, { binding: 2, resource: { buffer: partial } }] });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.normPipe); pass.setBindGroup(0, bind, [0]); pass.dispatchWorkgroups(dx, dy); pass.end();
    enc.copyBufferToBuffer(partial, 0, rb, 0, 4 * groups);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(rb.getMappedRange());
    let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i];
    rb.unmap(); rb.destroy(); partial.destroy();
    return sum;
  }

  /** Try to allocate an n-qubit state; false if the GPU refuses (limits or memory). */
  async tryAlloc(n) {
    this.free();
    if (n > this.maxQubits) return false;
    this.device.pushErrorScope("out-of-memory");
    this.device.pushErrorScope("validation");
    let threw = false;
    try { this.alloc(n); } catch { threw = true; }
    const v = await this.device.popErrorScope(), o = await this.device.popErrorScope();
    if (threw || v || o) { this.free(); return false; }
    return true;
  }

  free() { this.state?.destroy(); this.state = null; this.n = 0; }
}

/** Same interface on the CPU, for browsers without WebGPU. */
export class CPUEngine {
  constructor() {
    this.kind = "cpu";
    this.label = "CPU · float64";
    this.description = "WebGPU is not available in this browser";
    this.maxQubits = 24;
  }
  async run(n, steps) {
    const t0 = performance.now();
    this.out = cpuRun(n, steps); this.n = n;
    return performance.now() - t0;
  }
  async read() { return this.out; }
  async tryAlloc(n) { return n <= this.maxQubits; }
  async norm() { let s = 0; const { re, im } = this.out; for (let i = 0; i < re.length; i++) s += re[i] * re[i] + im[i] * im[i]; return s; }
  free() { this.out = null; }
}
