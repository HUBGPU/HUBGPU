// The hero machine: a graphics card whose engine is a quantum computer.
// A gold dilution-refrigerator chandelier hangs from above and feeds the card
// through coax lines; inside the glass shroud the two fan wells hold gyroscopic
// qubit cores and the centre window shows the QPU die. Under it all, a floor of
// qubit tiles flips between |0>, |1> and superposition. Click to measure.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const TOP_Y = 6.45; // top of the cryostat head, the highest point of the machine
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TAU = Math.PI * 2;

// one deterministic random stream so every load draws the same machine
let seed = 1337;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* ── palette ─────────────────────────────────────────────── */
const C = {
  gold: 0xd6a54c, goldHi: 0xf3cd78, silver: 0xd8dce4, copper: 0xc98654,
  ink: 0x0a0b10, graphite: 0x16181f,
  qubit: new THREE.Color(0.55, 0.55, 0.57),   // porcelain build: state reads in graphite on white
  qubitHot: new THREE.Color(0.02, 0.02, 0.025),
};

/* ── procedural textures ─────────────────────────────────── */
function canvasTex(w, h, draw, srgb = true) {
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  draw(cv.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Board art: gold traces routed at 0/45/90 degrees, vias, SMD parts, silkscreen. */
function pcbTextures() {
  const W = 2048, H = 900;
  const paths = [];
  for (let i = 0; i < 150; i++) {
    let x = rand() * W, y = rand() * H;
    const pts = [[x, y]];
    let dir = Math.floor(rand() * 8);
    for (let s = 0; s < 3 + Math.floor(rand() * 5); s++) {
      const len = 30 + rand() * 220;
      const a = (dir * Math.PI) / 4;
      x += Math.cos(a) * len; y += Math.sin(a) * len;
      pts.push([x, y]);
      dir = (dir + (rand() < 0.5 ? 1 : 7)) % 8;
    }
    paths.push({ pts, w: rand() < 0.2 ? 5 : 2 + rand() * 1.5, lit: rand() < 0.22 });
  }
  const parts = Array.from({ length: 220 }, () => ({
    x: rand() * W, y: rand() * H, w: 10 + rand() * 26, h: 6 + rand() * 12, rot: rand() < 0.5,
  }));
  const map = canvasTex(W, H, (g) => {
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#f7f7f6"); bg.addColorStop(1, "#efefee");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // ground pour hatch
    g.strokeStyle = "rgba(0,0,0,0.025)"; g.lineWidth = 1;
    for (let i = -H; i < W; i += 14) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + H, H); g.stroke(); }
    g.lineCap = "round"; g.lineJoin = "round";
    for (const p of paths) {
      g.strokeStyle = p.lit ? "rgba(20,20,22,0.38)" : "rgba(0,0,0,0.13)";
      g.lineWidth = p.w;
      g.beginPath(); p.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      const [ex, ey] = p.pts[p.pts.length - 1];
      g.fillStyle = "#d9d9d7"; g.beginPath(); g.arc(ex, ey, p.w + 3, 0, TAU); g.fill();
      g.fillStyle = "#9a9a98"; g.beginPath(); g.arc(ex, ey, p.w * 0.6, 0, TAU); g.fill();
    }
    for (const c of parts) {
      const w = c.rot ? c.h : c.w, h = c.rot ? c.w : c.h;
      g.fillStyle = "#e6e6e4"; g.fillRect(c.x, c.y, w, h);
      g.fillStyle = "#bdbdbb";
      if (c.rot) { g.fillRect(c.x, c.y, w, 4); g.fillRect(c.x, c.y + h - 4, w, 4); }
      else { g.fillRect(c.x, c.y, 4, h); g.fillRect(c.x + w - 4, c.y, 4, h); }
    }
    g.fillStyle = "rgba(20,20,22,0.7)";
    g.font = "600 30px ui-monospace, Menlo, monospace";
    g.fillText("HUB-Q1  REV.A  //  CRYO-COMPUTE BOARD", 90, H - 54);
    g.font = "500 22px ui-monospace, Menlo, monospace";
    g.fillText("10 mK  MXC-LINK  x6", W - 380, H - 54);
  });
  const emissive = canvasTex(W, H, (g) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#fff";
    for (const p of paths) {
      if (!p.lit) continue;
      g.lineWidth = p.w;
      g.beginPath(); p.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    }
  });
  return { map, emissive };
}

/** The QPU die seen through the centre window: couplers, readout resonators, label. */
function dieTexture() {
  return canvasTex(1024, 1024, (g, W) => {
    g.fillStyle = "#f4f4f3"; g.fillRect(0, 0, W, W);
    const n = 7, pad = 150, step = (W - pad * 2) / (n - 1);
    g.strokeStyle = "rgba(0,0,0,0.22)"; g.lineWidth = 6;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = pad + i * step, y = pad + j * step;
      if (i < n - 1) { g.beginPath(); g.moveTo(x, y); g.lineTo(x + step, y); g.stroke(); }
      if (j < n - 1 && (i + j) % 2 === 0) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + step); g.stroke(); }
    }
    // meandering readout resonators to the edge
    g.strokeStyle = "rgba(0,0,0,0.14)"; g.lineWidth = 3;
    for (let k = 0; k < 14; k++) {
      const side = k % 4, off = 120 + (k * 61) % (W - 240);
      g.beginPath();
      let x = side === 0 ? off : side === 1 ? W - 20 : side === 2 ? off : 20;
      let y = side === 0 ? 20 : side === 1 ? off : side === 2 ? W - 20 : off;
      g.moveTo(x, y);
      for (let m = 0; m < 6; m++) {
        if (side % 2 === 0) { x += m % 2 ? -18 : 18; y += side === 0 ? 14 : -14; }
        else { y += m % 2 ? -18 : 18; x += side === 1 ? -14 : 14; }
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = pad + i * step, y = pad + j * step;
      g.fillStyle = "#ffffff"; g.beginPath(); g.arc(x, y, 26, 0, TAU); g.fill();
      g.strokeStyle = "rgba(0,0,0,0.35)"; g.lineWidth = 4; g.beginPath(); g.arc(x, y, 26, 0, TAU); g.stroke();
    }
    g.fillStyle = "rgba(20,20,22,0.7)";
    g.font = "600 38px ui-monospace, Menlo, monospace";
    g.fillText("HUBGPU · Q1", 60, W - 50);
    g.textAlign = "right"; g.font = "500 28px ui-monospace, Menlo, monospace";
    g.fillText("49q LATTICE", W - 60, W - 52);
  });
}

function radialSprite(inner = "rgba(255,255,255,1)", mid = "rgba(255,255,255,0.25)") {
  return canvasTex(256, 256, (g) => {
    const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    r.addColorStop(0, inner); r.addColorStop(0.25, mid); r.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  });
}

function vaporSprite() {
  return canvasTex(256, 256, (g) => {
    for (let i = 0; i < 26; i++) {
      const x = 128 + (rand() - 0.5) * 120, y = 128 + (rand() - 0.5) * 70, r = 30 + rand() * 60;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, "rgba(255,255,255,0.12)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    }
  });
}

function backdrop() {
  return canvasTex(1024, 1280, (g, W, H) => {
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
    const v = g.createRadialGradient(W * 0.5, H * 0.45, W * 0.2, W * 0.5, H * 0.45, W * 0.95);
    v.addColorStop(0, "rgba(255,255,255,0)"); v.addColorStop(1, "rgba(0,0,0,0.035)");
    g.fillStyle = v; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(0,0,0,0.028)"; g.lineWidth = 1;
    for (let x = 0; x < W; x += 48) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y < H; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  });
}

/* ── shaders ─────────────────────────────────────────────── */
const coreMaterial = () => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uFlare: { value: 0 } },
  vertexShader: /* glsl */`
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      vP = position;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uFlare;
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.2);
      vec3 p = vP * 9.0;
      float s = sin(p.y * 1.7 + uTime * 3.1 + sin(p.x * 1.3 - uTime * 2.0) * 2.2);
      s += sin(p.z * 2.1 - uTime * 2.4 + cos(p.y * 1.1 + uTime) * 1.6);
      s = s * 0.25 + 0.5;
      vec3 a = vec3(0.015), b = vec3(0.09);
      vec3 col = mix(a, b, s) + vec3(0.85) * pow(f, 3.0);
      col = mix(col, vec3(0.92), uFlare * 0.85);
      gl_FragColor = vec4(col, 1.0);
    }`,
});

const arcMaterial = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uTime: { value: 0 }, uOff: { value: 0 }, uLife: { value: 1 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uOff; uniform float uLife; varying vec2 vUv;
    void main() {
      float head = fract(uTime * 0.55 + uOff);
      float d = vUv.x - head; d = d < 0.0 ? d + 1.0 : d;
      float pulse = exp(-d * 18.0) + exp(-(1.0 - d) * 60.0) * 0.6;
      float base = 0.12;
      gl_FragColor = vec4(vec3(0.06), min(1.0, base * 1.6 + pulse) * uLife * 0.8);
    }`,
});

const frostMaterial = (pr) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uTime: { value: 0 }, uPR: { value: pr } },
  vertexShader: /* glsl */`
    uniform float uTime; uniform float uPR;
    attribute float aSeed; varying float vA;
    void main() {
      vec3 p = position;
      float span = 10.0;
      p.y = mod(p.y - uTime * (0.08 + aSeed * 0.18) + 5.0, span) - 5.0;
      p.x += sin(uTime * 0.4 + aSeed * 40.0 + p.y * 0.6) * 0.25;
      p.z += cos(uTime * 0.3 + aSeed * 23.0) * 0.2;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = (1.2 + aSeed * 3.4) * uPR * (14.0 / -mv.z);
      vA = 0.25 + 0.55 * aSeed;
      vA *= smoothstep(-5.0, -3.5, p.y) * (1.0 - smoothstep(3.8, 5.0, p.y));
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      float a = smoothstep(0.5, 0.0, d);
      gl_FragColor = vec4(vec3(0.35), a * vA * 0.45);
    }`,
});

/* ── geometry helpers ────────────────────────────────────── */
function roundRect(s, x, y, w, h, r) {
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function circleLine(r, seg, mat, plane = "xz") {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * TAU;
    pts.push(plane === "xz" ? new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)
      : plane === "xy" ? new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)
        : new THREE.Vector3(0, Math.cos(a) * r, Math.sin(a) * r));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
}

/* ═══════════════════════════════════════════════════════════ */
export function mountScene(host, { reserve = () => ({ top: 0, bottom: 0 }) } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    host.classList.add("no-webgl");
    return null;
  }
  const small = matchMedia("(max-width: 820px)").matches;
  const PR = Math.min(small ? 1.5 : 1.75, devicePixelRatio || 1);
  renderer.setPixelRatio(PR);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const cv = renderer.domElement;
  cv.style.width = "100%"; cv.style.height = "100%"; cv.style.display = "block";
  host.prepend(cv);

  const scene = new THREE.Scene();
  scene.background = null; // the page's own white shows through, so the hero and the page are one sheet
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const LOOK = new THREE.Vector3(0, 0.35, 0);

  const rig = new THREE.Group();
  scene.add(rig);
  const machine = new THREE.Group();
  rig.add(machine);

  /* materials */
  const M = {
    gold: new THREE.MeshPhysicalMaterial({ color: 0xf3f3f1, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 }),      // matte porcelain
    goldHi: new THREE.MeshPhysicalMaterial({ color: 0xfafaf9, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12 }),     // glazed porcelain
    silver: new THREE.MeshPhysicalMaterial({ color: 0xe9e9eb, metalness: 0.85, roughness: 0.22 }),                            // pale chrome
    brushed: new THREE.MeshPhysicalMaterial({ color: 0xececea, metalness: 0.35, roughness: 0.45 }),                           // satin
    copper: new THREE.MeshPhysicalMaterial({ color: 0xdededc, roughness: 0.5, clearcoat: 0.2 }),
    ink: new THREE.MeshPhysicalMaterial({ color: 0xe4e4e2, roughness: 0.62 }),                                               // recessed wells read by shadow
    graphite: new THREE.MeshPhysicalMaterial({ color: 0xf0f0ee, roughness: 0.7 }),
    smoke: new THREE.MeshPhysicalMaterial({ color: 0xf6f6f5, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 }),
    black: new THREE.MeshPhysicalMaterial({ color: 0x0b0b0c, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 }),
  };

  /* ── 1. the dilution refrigerator chandelier ─────────────── */
  const fridge = new THREE.Group();
  machine.add(fridge);
  // stage plates, warm at the top to coldest at the bottom
  const STAGES = [
    { y: 4.25, r: 1.62, label: "50 K", name: "PT1 stage" },
    { y: 3.35, r: 1.42, label: "4 K", name: "PT2 stage" },
    { y: 2.5, r: 1.2, label: "800 mK", name: "Still" },
    { y: 1.72, r: 1.0, label: "100 mK", name: "Cold plate" },
    { y: 1.0, r: 0.82, label: "10 mK", name: "Mixing chamber" },
  ];
  const boltGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.03, 10);
  const totalBolts = STAGES.reduce((n, s) => n + Math.round(s.r * 18), 0);
  const bolts = new THREE.InstancedMesh(boltGeo, M.silver, totalBolts);
  let bi = 0;
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(1, 1, 1), tmpV = new THREE.Vector3();
  STAGES.forEach((s, i) => {
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(s.r, s.r, 0.075, 128), i % 2 ? M.goldHi : M.gold);
    plate.position.y = s.y;
    fridge.add(plate);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(s.r, 0.03, 12, 128), M.goldHi);
    rim.rotation.x = Math.PI / 2; rim.position.y = s.y;
    fridge.add(rim);
    // underside ring step for depth
    const step = new THREE.Mesh(new THREE.CylinderGeometry(s.r * 0.86, s.r * 0.86, 0.05, 96), M.brushed);
    step.position.y = s.y - 0.06;
    fridge.add(step);
    const nb = Math.round(s.r * 18);
    for (let k = 0; k < nb; k++) {
      const a = (k / nb) * TAU;
      tmpV.set(Math.cos(a) * s.r * 0.93, s.y + 0.05, Math.sin(a) * s.r * 0.93);
      tmpM.compose(tmpV, tmpQ.identity(), tmpS);
      bolts.setMatrixAt(bi++, tmpM);
    }
    // support rods down to the next stage
    const next = STAGES[i + 1];
    if (next) {
      const len = s.y - next.y;
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        const rr = next.r * 0.9;
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 12), M.silver);
        rod.position.set(Math.cos(a) * rr, next.y + len / 2, Math.sin(a) * rr);
        fridge.add(rod);
        // collar where the rod meets the plate
        const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.07, 14), M.goldHi);
        collar.position.set(rod.position.x, next.y + 0.07, rod.position.z);
        fridge.add(collar);
      }
    }
  });
  fridge.add(bolts);
  // still pot, heat exchanger stack, mixing chamber can and cold finger
  const still = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.42, 0.62, 3, 0.12), M.silver);
  still.position.y = 2.22; fridge.add(still);
  for (let k = 0; k < 6; k++) {
    const hx = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 40), k % 2 ? M.copper : M.goldHi);
    hx.position.y = 1.5 + k * 0.035 - 0.12; hx.position.x = 0.32; fridge.add(hx);
  }
  const hxTube = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 16), M.copper);
  hxTube.position.set(-0.3, 2.0, 0.1); fridge.add(hxTube);
  const mxc = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.34, 64), M.goldHi);
  mxc.position.y = 0.76; fridge.add(mxc);
  const finger = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 80), M.gold);
  finger.position.y = 0.55; fridge.add(finger);
  const fingerRim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.025, 10, 80), M.goldHi);
  fingerRim.rotation.x = Math.PI / 2; fingerRim.position.y = 0.55; fridge.add(fingerRim);
  // central column above the top plate, running out of frame
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.5, 32), M.brushed);
  column.position.y = 5.0; fridge.add(column);
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.09, 96), M.gold);
  flange.position.y = 5.78; fridge.add(flange);
  const flangeRim = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.03, 12, 96), M.goldHi);
  flangeRim.rotation.x = Math.PI / 2; flangeRim.position.y = 5.78; fridge.add(flangeRim);
  const head = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.42, 0.62, 3, 0.12), M.brushed);
  head.position.y = 6.05; fridge.add(head);
  const headCap = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.16, 40), M.goldHi);
  headCap.position.y = 6.33; fridge.add(headCap);
  for (const [x, zz] of [[-0.55, 0.2], [0.55, -0.15]]) {
    const port = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.3, 20), M.silver);
    port.position.set(x, 5.95, zz); fridge.add(port);
  }

  // helical coax lines winding down through the stages
  const curves = [];
  const coaxGeoMats = [M.silver, M.copper];
  for (let c = 0; c < 9; c++) {
    const a0 = (c / 9) * TAU;
    const pts = [];
    // straight bundle down the column, a flare out under the top plate, then the helix
    pts.push(new THREE.Vector3(Math.cos(a0) * 0.62, 5.73, Math.sin(a0) * 0.62));
    pts.push(new THREE.Vector3(Math.cos(a0) * 0.32, 5.25, Math.sin(a0) * 0.32));
    pts.push(new THREE.Vector3(Math.cos(a0) * 0.3, 4.95, Math.sin(a0) * 0.3));
    pts.push(new THREE.Vector3(Math.cos(a0) * 0.75, 4.55, Math.sin(a0) * 0.75));
    for (let k = 0; k <= 22; k++) {
      const t = k / 22;
      const y = 4.12 - t * (4.12 - 0.62);
      const r = THREE.MathUtils.lerp(1.22, 0.42, Math.pow(t, 0.85));
      const a = a0 + t * Math.PI * 0.9;
      pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    curves.push(curve);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.022, 8), coaxGeoMats[c % 2]);
    fridge.add(tube);
    // an attenuator where the line passes each stage
    STAGES.slice(1).forEach((s) => {
      const p = pts.reduce((best, q) => (Math.abs(q.y - (s.y - 0.12)) < Math.abs(best.y - (s.y - 0.12)) ? q : best), pts[0]).clone();
      const att = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.16, 12), c % 3 ? M.silver : M.goldHi);
      att.position.copy(p);
      fridge.add(att);
    });
  }

  /* ── 2. the card ─────────────────────────────────────────── */
  const card = new THREE.Group();
  const L = 7.6, H = 2.7, PCB_EXTRA = 0.42;
  const pcbTex = pcbTextures();
  const pcbFace = new THREE.MeshStandardMaterial({
    map: pcbTex.map, emissiveMap: pcbTex.emissive, emissive: new THREE.Color(0, 0, 0), emissiveIntensity: 0,
    roughness: 0.5, metalness: 0.35,
  });
  const pcbEdge = new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.6 });
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(L, H + PCB_EXTRA, 0.09), [pcbEdge, pcbEdge, pcbEdge, pcbEdge, pcbFace, pcbFace]);
  pcb.position.set(0, -PCB_EXTRA / 2, -0.36);
  card.add(pcb);
  // brushed backplate peeking out behind
  const backplate = new THREE.Mesh(new RoundedBoxGeometry(L + 0.05, H - 0.05, 0.06, 2, 0.05), M.brushed);
  backplate.position.z = -0.45; card.add(backplate);

  // PCIe fingers, gold
  const fingerGeo = new THREE.BoxGeometry(0.075, 0.32, 0.1);
  const fingers = new THREE.InstancedMesh(fingerGeo, M.goldHi, 30);
  for (let i = 0; i < 30; i++) {
    tmpV.set(-1.5 + i * 0.112 + (i > 6 ? 0.16 : 0), -H / 2 - PCB_EXTRA - 0.13, -0.36);
    tmpM.compose(tmpV, tmpQ.identity(), tmpS); fingers.setMatrixAt(i, tmpM);
  }
  card.add(fingers);

  // interior under the glass: dark tray + heatsink fins
  const tray = new THREE.Mesh(new RoundedBoxGeometry(L - 0.35, H - 0.2, 0.08, 2, 0.1), M.ink);
  tray.position.z = -0.27; card.add(tray);
  const finGeo = new THREE.BoxGeometry(0.025, H - 0.55, 0.26);
  const finSpots = [];
  for (let x = -L / 2 + 0.4; x < L / 2 - 0.35; x += 0.085) if (Math.abs(x) > 0.92) finSpots.push(x);
  const fins = new THREE.InstancedMesh(finGeo, M.silver, finSpots.length);
  finSpots.forEach((x, i) => { tmpV.set(x, 0, -0.1); tmpM.compose(tmpV, tmpQ.identity(), tmpS); fins.setMatrixAt(i, tmpM); });
  card.add(fins);
  // copper heat pipes along the length
  const pipeLen = L / 2 - 0.4 - 0.95;
  for (const y of [-0.75, -0.25, 0.25, 0.75]) for (const sgn of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, pipeLen, 16), M.copper);
    pipe.rotation.z = Math.PI / 2; pipe.position.set(sgn * (0.95 + pipeLen / 2), y, 0.05); card.add(pipe);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), M.copper);
    cap.position.set(sgn * 0.95, y, 0.05); card.add(cap);
  }

  // glass shroud with two fan openings and a square window for the die
  const CORE_X = 2.4, CORE_R = 1.12, WIN = 1.62;
  const shape = roundRect(new THREE.Shape(), -(L - 0.3) / 2, -(H - 0.14) / 2, L - 0.3, H - 0.14, 0.26);
  for (const x of [-CORE_X, CORE_X]) { const h = new THREE.Path(); h.absarc(x, 0, CORE_R, 0, TAU, true); shape.holes.push(h); }
  shape.holes.push(roundRect(new THREE.Path(), -WIN / 2, -WIN / 2, WIN, WIN, 0.16));
  const shroudGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.42, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 4, curveSegments: 64 });
  shroudGeo.translate(0, 0, -0.21);
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transmission: 1, thickness: 0.6, roughness: 0.32, ior: 1.5,
    clearcoat: 1, clearcoatRoughness: 0.05, attenuationColor: new THREE.Color(0.96, 0.96, 0.96), attenuationDistance: 3,
    specularIntensity: 1,
  });
  const shroud = new THREE.Mesh(shroudGeo, glass);
  card.add(shroud);
  // chrome bezels round each opening
  for (const x of [-CORE_X, CORE_X]) {
    const bez = new THREE.Mesh(new THREE.TorusGeometry(CORE_R + 0.02, 0.055, 16, 128), M.silver);
    bez.position.set(x, 0, 0.27); card.add(bez);
  }
  const winFrame = new THREE.Mesh(
    new THREE.ExtrudeGeometry(
      (() => { const s = roundRect(new THREE.Shape(), -WIN / 2 - 0.07, -WIN / 2 - 0.07, WIN + 0.14, WIN + 0.14, 0.2); s.holes.push(roundRect(new THREE.Path(), -WIN / 2, -WIN / 2, WIN, WIN, 0.16)); return s; })(),
      { depth: 0.04, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 2, curveSegments: 24 },
    ), M.silver);
  winFrame.position.z = 0.25; card.add(winFrame);

  // the light bar and wordmark along the lower edge
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.03, 0.02), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.04, 0.04, 0.045) }));
  bar.position.set(0, -H / 2 + 0.12, 0.3); card.add(bar);
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.2), new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false,
    map: canvasTex(640, 80, (g, w, h) => {
      g.fillStyle = "rgba(12,12,14,0.9)"; g.font = "600 46px ui-monospace, Menlo, monospace";
      g.textBaseline = "middle"; g.fillText("HUBGPU", 70, h / 2 + 2);
      g.fillStyle = "rgba(12,12,14,0.45)"; g.font = "500 26px ui-monospace, Menlo, monospace"; g.fillText("Q1 · CRYO", 362, h / 2 + 3);
    }),
  }));
  mark.position.set(0, 1.04, 0.3); card.add(mark);
  const spec = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.15), new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false,
    map: canvasTex(640, 64, (g, w, h) => {
      g.fillStyle = "rgba(12,12,14,0.55)"; g.font = "500 30px ui-monospace, Menlo, monospace";
      g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("49 QUBITS  ·  10 mK  ·  6× MXC", w / 2, h / 2 + 2);
    }),
  }));
  spec.position.set(0, -1.02, 0.3); card.add(spec);

  // QPU die in the centre window
  const die = new THREE.Group();
  const substrate = new THREE.Mesh(new RoundedBoxGeometry(1.4, 1.4, 0.06, 2, 0.04), M.gold);
  die.add(substrate);
  const dieTop = new THREE.Mesh(new THREE.BoxGeometry(1.02, 1.02, 0.05), new THREE.MeshStandardMaterial({ map: dieTexture(), roughness: 0.28, metalness: 0.55 }));
  dieTop.position.z = 0.05; die.add(dieTop);
  const qN = 7;
  const qubitDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.03, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }), qN * qN);
  const qubitState = [];
  for (let i = 0; i < qN; i++) for (let j = 0; j < qN; j++) {
    const k = i * qN + j;
    const s = 1.02 * (150 / 1024), step = (1.02 - 2 * s) / (qN - 1);
    tmpV.set(-0.51 + s + i * step, 0.51 - s - j * step, 0.085);
    tmpM.compose(tmpV, tmpQ.identity(), tmpS); qubitDots.setMatrixAt(k, tmpM);
    qubitState.push({ phase: rand() * TAU, speed: 0.6 + rand() * 2.2 });
    qubitDots.setColorAt(k, C.qubit);
  }
  die.add(qubitDots);
  // wire bonds from die pads to the substrate
  const bondGeoPts = [];
  for (let side = 0; side < 4; side++) for (let k = 0; k < 9; k++) {
    const u = -0.42 + k * 0.105;
    const a = new THREE.Vector3(u, 0.5, 0.075), b = new THREE.Vector3(u * 1.18, 0.66, 0.035);
    const m = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5).setZ(0.16);
    const rot = new THREE.Matrix4().makeRotationZ(side * Math.PI / 2);
    bondGeoPts.push(new THREE.QuadraticBezierCurve3(a.applyMatrix4(rot), m.applyMatrix4(rot), b.applyMatrix4(rot)));
  }
  for (const cu of bondGeoPts) die.add(new THREE.Mesh(new THREE.TubeGeometry(cu, 8, 0.006, 4), M.goldHi));
  die.position.z = 0.02;
  card.add(die);

  // gyroscopic qubit cores in the fan wells
  const cores = [];
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0.3, -0.1);
  bladeShape.bezierCurveTo(0.55, -0.08, 0.86, 0.1, 1.04, 0.44);
  bladeShape.bezierCurveTo(0.78, 0.32, 0.52, 0.22, 0.3, 0.17);
  bladeShape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.025, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1 });
  const glowTex = radialSprite("rgba(200,220,255,1)", "rgba(110,140,255,0.35)");
  const sparkGeo = new THREE.SphereGeometry(0.035, 12, 8);
  const sparkMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.04, 0.04, 0.045) });
  for (const x of [-CORE_X, CORE_X]) {
    const core = new THREE.Group();
    core.position.set(x, 0, 0);
    const well = new THREE.Mesh(new THREE.CylinderGeometry(CORE_R, CORE_R, 0.08, 96), M.ink);
    well.rotation.x = Math.PI / 2; well.position.z = -0.2; core.add(well);
    // concentric guide rings in the well floor
    for (const r of [0.45, 0.7, 0.95]) {
      const g = new THREE.Mesh(new THREE.TorusGeometry(r, 0.008, 6, 96), M.goldHi);
      g.position.z = -0.15; core.add(g);
    }
    const rotor = new THREE.Group();
    for (let i = 0; i < 11; i++) {
      const bl = new THREE.Mesh(bladeGeo, M.smoke);
      bl.rotation.z = (i / 11) * TAU; bl.rotation.y = 0.18;
      rotor.add(bl);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.12, 64), M.gold);
    hub.rotation.x = Math.PI / 2; hub.position.z = 0.02; rotor.add(hub);
    const hubRing = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.018, 8, 64), M.goldHi);
    hubRing.position.z = 0.08; rotor.add(hubRing);
    rotor.position.z = -0.08;
    core.add(rotor);

    // nested gimbal: three gold rings, each turning on a different axis
    const gim = new THREE.Group(); gim.position.z = 0.42;
    const g1 = new THREE.Group(), g2 = new THREE.Group(), g3 = new THREE.Group();
    gim.add(g1); g1.add(g2); g2.add(g3);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.03, 16, 160), M.goldHi); g1.add(r1);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.026, 16, 140), M.gold); g2.add(r2);
    const r3 = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.022, 16, 120), M.silver); g3.add(r3);
    // bearings at the pivots
    for (const [g, r, axis] of [[g1, 0.74, "y"], [g2, 0.6, "x"], [g3, 0.46, "y"]]) {
      for (const sgn of [-1, 1]) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), M.silver);
        if (axis === "y") b.position.y = sgn * r; else b.position.x = sgn * r;
        g.add(b);
      }
    }
    // sparks riding the rings
    const sp1 = new THREE.Mesh(sparkGeo, sparkMat); sp1.position.x = 0.74; r1.add(sp1);
    const sp2 = new THREE.Mesh(sparkGeo, sparkMat); sp2.position.y = -0.6; r2.add(sp2);
    // the qubit itself
    const orbMat = coreMaterial();
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.24, 64, 48), orbMat);
    gim.add(orb);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(0.32, 0.42, 1.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
    glow.scale.setScalar(1.6); glow.visible = false; gim.add(glow);
    const light = new THREE.PointLight(0xffffff, 0, 2.6, 1.8);
    gim.add(light);
    core.add(gim);
    card.add(core);
    cores.push({ rotor, g1, g2, g3, orbMat, glow, light, sp1, sp2 });
  }

  // I/O bracket with ports
  const bracket = new THREE.Group();
  bracket.add(new THREE.Mesh(new RoundedBoxGeometry(0.1, H + 0.6, 1.0, 2, 0.03), M.silver));
  for (let i = 0; i < 4; i++) {
    const port = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.34, 0.2, 2, 0.05), M.ink);
    port.position.set(0.02, 0.95 - i * 0.48, 0.18); bracket.add(port);
  }
  for (let i = 0; i < 5; i++) {
    const vent = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.08, 0.5, 2, 0.03), M.ink);
    vent.position.set(0.02, -1.15 + i * 0.13 + 0.0, -0.2); bracket.add(vent);
  }
  const tab = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 1.0), M.silver);
  tab.position.set(0.25, (H + 0.6) / 2, 0); bracket.add(tab);
  bracket.position.set(-L / 2 - 0.03, -0.1, -0.12);
  card.add(bracket);

  // SMA connectors on the top edge, where the cryostat lines land
  const SMA_X = [-1.75, -1.05, -0.35, 0.35, 1.05, 1.75];
  const smaTops = [];
  for (const x of SMA_X) {
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 6), M.goldHi);
    nut.position.set(x, H / 2 + 0.06, -0.12); card.add(nut);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.22, 20), M.gold);
    body.position.set(x, H / 2 + 0.22, -0.12); card.add(body);
    smaTops.push(new THREE.Vector3(x, H / 2 + 0.33, -0.12));
  }

  card.scale.setScalar(0.74);
  card.rotation.set(-0.46, 0.4, 0.12);
  card.position.set(0.05, -1.42, 1.5);
  machine.add(card);

  // lower coax: from the cold finger down to the card's connectors
  machine.updateMatrixWorld(true);
  const cardUp = new THREE.Vector3(0, 1, 0).applyQuaternion(card.quaternion);
  const lowerMats = [M.silver, M.copper];
  SMA_X.forEach((_, i) => {
    const a = Math.PI * 0.15 + (i / (SMA_X.length - 1)) * Math.PI * 0.7;
    const start = new THREE.Vector3(Math.cos(a) * 0.38 * -1, 0.52, Math.sin(a) * 0.3 + 0.05);
    const end = card.localToWorld(smaTops[i].clone());
    const p1 = start.clone().add(new THREE.Vector3(0, -0.45, 0.1));
    const p2 = end.clone().add(cardUp.clone().multiplyScalar(0.5));
    const curve = new THREE.CatmullRomCurve3([start, p1, p2, end]);
    curves.push(curve);
    machine.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.024, 8), lowerMats[i % 2]));
  });

  // microwave control pulses travelling down every line
  const PULSES_PER = 2, TRAIL = 4;
  const pulseGeo = new THREE.SphereGeometry(0.038, 10, 8);
  const pulses = new THREE.InstancedMesh(pulseGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), curves.length * PULSES_PER * TRAIL);
  const pulseCol = new THREE.Color();
  machine.add(pulses);
  const pulseSeeds = curves.map(() => Array.from({ length: PULSES_PER }, () => ({ off: rand(), speed: 0.12 + rand() * 0.1 })));

  /* ── 3. qubit floor ──────────────────────────────────────── */
  const COLS = 29, ROWS = 9, CELL = 0.46, GAP = 0.1;
  const floor = new THREE.Group();
  const tileGeo = new RoundedBoxGeometry(CELL, CELL, 0.12, 3, 0.06);
  const tileMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.4, clearcoat: 0.9, clearcoatRoughness: 0.15 });
  const tiles = new THREE.InstancedMesh(tileGeo, tileMat, COLS * ROWS);
  const COL0 = new THREE.Color(0.93, 0.93, 0.92);      // |0>
  const COL1 = new THREE.Color(0.03, 0.03, 0.035);     // |1>
  const COLS_ = new THREE.Color(0.66, 0.66, 0.66);     // superposition
  const stateCol = [COL0, COL1, COLS_];
  const T = [];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    const centre = 1 - Math.hypot((c - (COLS - 1) / 2) / COLS, (r - (ROWS - 1) / 2) / ROWS) * 1.6;
    const st = rand() < 0.18 * centre ? 2 : rand() < 0.22 ? 1 : 0;
    T.push({
      x: (c - (COLS - 1) / 2) * (CELL + GAP), y: ((ROWS - 1) / 2 - r) * (CELL + GAP),
      c, r, state: st, next: st, flip: -1, flash: 0, lift: 0,
    });
  }
  const tileCol = new THREE.Color();
  const tileEuler = new THREE.Euler();
  function writeTile(i) {
    const t = T[i];
    const k = t.flip < 0 ? 0 : ease(t.flip);
    const shown = t.flip >= 0.5 ? t.next : t.state;
    tileEuler.set(k * Math.PI, 0, 0);
    tmpQ.setFromEuler(tileEuler);
    tmpV.set(t.x, t.y, t.lift + Math.sin(k * Math.PI) * 0.25 + (shown === 2 ? 0.07 : shown === 1 ? 0.03 : 0));
    tmpM.compose(tmpV, tmpQ, tmpS);
    tiles.setMatrixAt(i, tmpM);
    tileCol.copy(stateCol[shown]);
    if (t.flash > 0) tileCol.lerp(C.qubit, Math.min(1, t.flash) * 0.6);
    tiles.setColorAt(i, tileCol);
  }
  T.forEach((_, i) => writeTile(i));
  floor.add(tiles);
  // a fine gold frame round the lattice
  const fw = COLS * (CELL + GAP) + 0.2, fh = ROWS * (CELL + GAP) + 0.2;
  const frameShape = roundRect(new THREE.Shape(), -fw / 2 - 0.06, -fh / 2 - 0.06, fw + 0.12, fh + 0.12, 0.2);
  frameShape.holes.push(roundRect(new THREE.Path(), -fw / 2, -fh / 2, fw, fh, 0.16));
  const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(frameShape, { depth: 0.05, bevelEnabled: false, curveSegments: 16 }), M.gold);
  frame.position.z = -0.08; floor.add(frame);
  const slab = new THREE.Mesh(new RoundedBoxGeometry(fw + 0.4, fh + 0.4, 0.14, 2, 0.12), M.graphite);
  slab.position.z = -0.14; floor.add(slab);

  floor.rotation.set(-1.25, 0, 0.0);
  floor.position.set(0, -4.6, -2.6);
  rig.add(floor);

  // entanglement arcs between tile pairs
  const arcs = [];
  function placeArc(a) {
    // pairs stay within a few columns so the arcs read as links, not lassos
    const i = Math.floor(rand() * T.length);
    const dc = (3 + Math.floor(rand() * 4)) * (rand() < 0.5 ? -1 : 1);
    const c2 = Math.max(0, Math.min(COLS - 1, T[i].c + dc)), r2 = Math.floor(rand() * ROWS);
    const j = c2 * ROWS + r2;
    const A = new THREE.Vector3(T[i].x, T[i].y, 0.1), B = new THREE.Vector3(T[j].x, T[j].y, 0.1);
    const mid = A.clone().add(B).multiplyScalar(0.5); mid.z = 0.6 + A.distanceTo(B) * 0.35;
    a.mesh.geometry.dispose();
    a.mesh.geometry = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(A, mid, B), 64, 0.014, 6);
    a.i = i; a.j = j; a.age = 0; a.life = 3.5 + rand() * 3;
    a.mesh.material.uniforms.uOff.value = rand();
  }
  for (let k = 0; k < 6; k++) {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), arcMaterial());
    floor.add(mesh);
    const a = { mesh };
    placeArc(a); a.age = rand() * a.life;
    arcs.push(a);
  }

  /* ── 4. Bloch spheres ────────────────────────────────────── */
  const lineMat = new THREE.LineBasicMaterial({ color: 0x111113, transparent: true, opacity: 0.4 });
  const lineFaint = new THREE.LineBasicMaterial({ color: 0x111113, transparent: true, opacity: 0.13 });
  function makeBloch() {
    const g = new THREE.Group();
    g.add(circleLine(1, 96, lineMat, "xz"));
    g.add(circleLine(1, 96, lineFaint, "xy"));
    g.add(circleLine(1, 96, lineFaint, "yz"));
    for (const y of [-0.5, 0.5]) { const l = circleLine(Math.sqrt(1 - y * y), 72, lineFaint, "xz"); l.position.y = y; g.add(l); }
    const axis = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -1.2, 0), new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(-1.2, 0, 0), new THREE.Vector3(1.2, 0, 0),
      new THREE.Vector3(0, 0, -1.2), new THREE.Vector3(0, 0, 1.2)]);
    g.add(new THREE.LineSegments(axis, lineFaint));
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, roughness: 0.15, thickness: 0.3, transparent: true, opacity: 0.6 }));
    g.add(shell);
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.86, 12), M.black);
    shaft.position.y = 0.43; arrow.add(shaft);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 20), M.black);
    head.position.y = 0.92; arrow.add(head);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.02, 0.02, 0.02) }));
    tip.position.y = 1.0; arrow.add(tip);
    g.add(arrow);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), M.silver); g.add(hub);
    // precession trail on the sphere
    const TRAILN = 90;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAILN * 3), 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x111113, transparent: true, opacity: 0.55 }));
    g.add(trail);
    return { g, arrow, trail, trailPts: [], theta: 1, phi: 0 };
  }
  const blochA = makeBloch();
  blochA.g.scale.setScalar(0.62); blochA.g.position.set(-2.7, 2.1, 0.6);
  rig.add(blochA.g);
  const blochB = makeBloch();
  blochB.g.scale.setScalar(0.42); blochB.g.position.set(3.0, -0.15, 0.6);
  rig.add(blochB.g);

  /* ── 5. cryogenic atmosphere ─────────────────────────────── */
  const FROST = small ? 160 : 420;
  const fpos = new Float32Array(FROST * 3), fseed = new Float32Array(FROST);
  for (let i = 0; i < FROST; i++) {
    const near = rand() < 0.45;
    fpos[i * 3] = near ? (rand() - 0.5) * 3.2 : (rand() - 0.5) * 22;
    fpos[i * 3 + 1] = (rand() - 0.5) * 10;
    fpos[i * 3 + 2] = near ? (rand() - 0.5) * 2.6 : -3 + rand() * 5;
    fseed[i] = rand();
  }
  const frostGeo = new THREE.BufferGeometry();
  frostGeo.setAttribute("position", new THREE.BufferAttribute(fpos, 3));
  frostGeo.setAttribute("aSeed", new THREE.BufferAttribute(fseed, 1));
  const frostMat = frostMaterial(PR);
  const frost = new THREE.Points(frostGeo, frostMat);
  frost.frustumCulled = false;
  rig.add(frost);

  const vaporTex = vaporSprite();
  const vapors = [];
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: vaporTex, color: new THREE.Color(0.55, 0.65, 1.0), transparent: true, opacity: 0.0, depthWrite: false, blending: THREE.AdditiveBlending }));
    const sc = 1.6 + rand() * 1.8;
    s.scale.set(sc * 1.6, sc, 1);
    s.userData = { x: (rand() - 0.5) * 2.4, y: 0.3 + rand() * 4, z: (rand() - 0.5) * 1.5, ph: rand() * TAU, sp: 0.05 + rand() * 0.08, base: 0.05 + rand() * 0.06 };
    rig.add(s);
    s.visible = false;
    vapors.push(s);
  }

  /* lights */
  // a soft studio: one shadow-casting key, a broad sky fill, a cool rim to separate white from white
  const key = new THREE.DirectionalLight(0xffffff, 3.1); key.position.set(5, 9, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 6;
  const rim = new THREE.DirectionalLight(0xf2f4ff, 1.1); rim.position.set(-6, 4, -6);
  const fill = new THREE.HemisphereLight(0xffffff, 0xc9c9c7, 0.75);
  scene.add(key, rim, fill);

  // every solid casts and catches shadow: in an all-white scene, shadow is what draws the form
  rig.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
  shroud.castShadow = false;
  tiles.castShadow = true;

  /* ── post ────────────────────────────────────────────────── */
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(PR);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.42, 0.95);
  bloom.enabled = false; // nothing glows in the porcelain build
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ── HUD overlay ─────────────────────────────────────────── */
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `
    <svg class="hud-lines" aria-hidden="true"></svg>
    <div class="hud-stats">
      <span class="hs"><span class="hud-k">State</span><span class="hud-v hud-psi"></span></span>
      <span class="hs"><span class="hud-k hud-mk">Measure</span><span class="hud-v hud-bits">|··········⟩</span></span>
      <span class="hs hint">Tap the machine to collapse it.</span>
    </div>`;
  host.append(hud);
  const svg = hud.querySelector(".hud-lines");
  const psiEl = hud.querySelector(".hud-psi"), bitsEl = hud.querySelector(".hud-bits"), mkEl = hud.querySelector(".hud-mk");
  const tags = STAGES.map((s) => {
    const el = document.createElement("div");
    el.className = "hud-tag";
    el.innerHTML = `<b>${s.label}</b><span>${s.name}</span>`;
    hud.append(el);
    const ln = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.append(ln);
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("r", "2.2"); svg.append(dot);
    return { el, ln, dot, s };
  });
  const proj = new THREE.Vector3();
  function placeTags(w, h) {
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    tags.forEach((t, i) => {
      proj.set(t.s.r * 0.98, t.s.y, 0.0);
      fridge.localToWorld(proj);
      proj.project(camera);
      const x = (proj.x * 0.5 + 0.5) * w, y = (-proj.y * 0.5 + 0.5) * h;
      const visible = y > 54 && y < h - 40;
      t.el.style.opacity = visible ? "" : "0";
      t.ln.style.opacity = t.dot.style.opacity = visible ? "" : "0";
      const ty = y;
      const elW = t.el.offsetWidth || 90;
      const right = Math.min(w - 18, x + Math.max(150, w * 0.12) + elW);
      t.el.style.transform = `translate(${right}px, ${ty}px) translate(-100%, -50%)`;
      const lx = right - elW - 10;
      t.ln.setAttribute("d", `M${x.toFixed(1)} ${y.toFixed(1)} L${lx.toFixed(1)} ${ty.toFixed(1)}`);
      t.dot.setAttribute("cx", x.toFixed(1)); t.dot.setAttribute("cy", y.toFixed(1));
    });
  }

  /* ── sizing ──────────────────────────────────────────────── */
  let W = 1, Hh = 1;
  function fit() {
    W = host.clientWidth || 1; Hh = host.clientHeight || 1;
    renderer.setSize(W, Hh, false);
    composer.setSize(W, Hh);
    bloom.resolution.set(W * PR * 0.5, Hh * PR * 0.5);
    camera.aspect = W / Hh;
    camera.updateProjectionMatrix();
    // Frame the whole machine (top stage plate down to the floor's front edge)
    // inside the band the page UI leaves free, so nothing sits under text.
    const r = reserve();
    const topPx = r.top + 14, botPx = Hh - r.bottom - 10;
    const yTop = TOP_Y, yBot = -5.45;           // cryostat head down to the floor's front edge
    const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const band = Math.max(0.3, (botPx - topPx) / Hh);
    let z = (yTop - yBot) / (2 * tanH * band);
    z = Math.max(z, 4.4 / (tanH * camera.aspect)); // the card and both Bloch spheres stay in width
    const vh = 2 * z * tanH;
    const cy = (yTop + yBot) / 2 + (((topPx + botPx) / 2 - Hh / 2) / Hh) * vh;
    LOOK.set(0, cy, 0);
    camera.position.set(0, cy, z);
    camera.lookAt(LOOK);
    const spread = THREE.MathUtils.clamp(camera.aspect / 0.8, 1, 1.75);
    blochA.g.position.x = -2.7 * spread;
    blochB.g.position.x = 3.0 * spread;
  }
  fit();

  /* ── measurement ─────────────────────────────────────────── */
  let flare = 0, collapse = 0, lastBits = "";
  function measure() {
    flare = 1; collapse = 1.4;
    // superposed tiles collapse to a definite value, everyone flashes outward from the centre
    T.forEach((t) => {
      const d = Math.hypot(t.c - (COLS - 1) / 2, t.r - (ROWS - 1) / 2);
      setTimeout(() => {
        if (t.flip < 0) { t.next = t.state === 2 ? (Math.random() < 0.5 ? 0 : 1) : t.state; t.flip = t.next !== t.state ? 0 : -1; }
        t.flash = 0.9;
      }, d * 55);
    });
    let bits = "";
    for (let i = 0; i < 10; i++) bits += Math.random() < 0.5 ? "0" : "1";
    lastBits = bits;
    bitsEl.textContent = `|${bits}⟩`;
    mkEl.textContent = "Measured";
    setTimeout(() => { mkEl.textContent = "Measure"; }, 2600);
  }
  host.addEventListener("click", measure);

  /* ── motion ──────────────────────────────────────────────── */
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  addEventListener("pointermove", (e) => {
    pointer.tx = (e.clientX / innerWidth - 0.5) * 2;
    pointer.ty = (e.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });

  let gateClock = 0, waveClock = 0, wave = -1, frameNo = 0, prevT = 0;
  const ax = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  function stepBloch(b, t, rate, tilt) {
    b.phi = t * rate;
    b.theta = tilt + Math.sin(t * 0.37) * 0.55;
    if (collapse > 0) b.theta = THREE.MathUtils.lerp(b.theta, lastBits[0] === "1" ? Math.PI : 0, Math.min(1, collapse));
    ax.set(Math.sin(b.theta) * Math.cos(b.phi), Math.cos(b.theta), Math.sin(b.theta) * Math.sin(b.phi));
    b.arrow.quaternion.setFromUnitVectors(up, ax);
    b.trailPts.push(ax.clone());
    if (b.trailPts.length > 90) b.trailPts.shift();
    const arr = b.trail.geometry.attributes.position.array;
    for (let i = 0; i < 90; i++) {
      const p = b.trailPts[Math.max(0, b.trailPts.length - 90 + i)] || ax;
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    }
    b.trail.geometry.attributes.position.needsUpdate = true;
  }

  function pose(t) {
    const dt = Math.min(0.05, t - prevT); prevT = t;
    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;
    rig.rotation.y = pointer.x * 0.14;
    rig.rotation.x = pointer.y * 0.06;
    machine.position.y = Math.sin(t * 0.8) * 0.08;
    fridge.rotation.y = Math.sin(t * 0.21) * 0.06;

    flare = Math.max(0, flare - dt * 0.9);
    collapse = Math.max(0, collapse - dt * 0.7);

    // cores
    cores.forEach((c, i) => {
      const s = i ? 1 : -1;
      c.rotor.rotation.z = -t * (3.2 + i * 0.4) * (1 + flare * 2);
      c.g1.rotation.y = t * 0.9 * s;
      c.g2.rotation.x = t * 1.35;
      c.g3.rotation.y = -t * 2.1 * s;
      c.g3.rotation.z = t * 0.6;
      c.orbMat.uniforms.uTime.value = t + i * 3;
      c.orbMat.uniforms.uFlare.value = flare;
      const breathe = 0.32 + Math.sin(t * 2.2 + i) * 0.06;
      c.glow.material.opacity = breathe + flare * 0.5;
      c.glow.scale.setScalar(1.6 + Math.sin(t * 1.7 + i) * 0.1 + flare * 1.2);
      c.light.intensity = flare * 4;
    });

    // die qubits shimmer
    for (let k = 0; k < qN * qN; k++) {
      const q = qubitState[k];
      const v = Math.pow(0.5 + 0.5 * Math.sin(t * q.speed + q.phase), 3);
      tileCol.copy(C.qubit).lerp(C.qubitHot, Math.min(1, v + flare));
      qubitDots.setColorAt(k, tileCol);
    }
    qubitDots.instanceColor.needsUpdate = true;
    pcbFace.emissiveIntensity = 0.5 + Math.sin(t * 1.3) * 0.2 + flare;

    // pulses
    let pi = 0;
    curves.forEach((cu, ci) => {
      pulseSeeds[ci].forEach((p) => {
        const head = (t * p.speed * (1 + flare) + p.off) % 1;
        for (let k = 0; k < TRAIL; k++) {
          const u = head - k * 0.012;
          const uu = u < 0 ? u + 1 : u;
          cu.getPointAt(uu, tmpV);
          const fade = (1 - k / TRAIL) * Math.min(1, uu * 12) * Math.min(1, (1 - uu) * 12);
          tmpS.setScalar(Math.max(0.001, fade * (k === 0 ? 0.75 : 0.45)));
          tmpM.compose(tmpV, tmpQ.identity(), tmpS);
          pulses.setMatrixAt(pi, tmpM);
          pulseCol.setRGB(0.05, 0.05, 0.055);
          pulses.setColorAt(pi, pulseCol);
          pi++;
        }
      });
    });
    tmpS.set(1, 1, 1);
    pulses.instanceMatrix.needsUpdate = true;
    if (pulses.instanceColor) pulses.instanceColor.needsUpdate = true;

    // qubit floor: gates fire, entangled pairs flip together, a wave sweeps through
    gateClock += dt; waveClock += dt;
    while (gateClock > 0.085) {
      gateClock -= 0.085;
      const i = Math.floor(Math.random() * T.length);
      const tt = T[i];
      if (tt.flip < 0) {
        const r = Math.random();
        tt.next = r < 0.42 ? 2 : r < 0.72 ? 1 : 0;
        if (tt.next !== tt.state) tt.flip = 0;
      }
    }
    if (waveClock > 6.5) { waveClock = 0; wave = 0; }
    if (wave >= 0) { wave += dt * 9; if (wave > COLS + ROWS + 6) wave = -1; }
    for (let i = 0; i < T.length; i++) {
      const tt = T[i];
      if (tt.flip >= 0) {
        tt.flip += dt * 1.9;
        if (tt.flip >= 1) { tt.state = tt.next; tt.flip = -1; }
      }
      if (wave >= 0) {
        const d = wave - (tt.c + tt.r * 0.6);
        const w = d > 0 && d < 2.5 ? Math.sin((d / 2.5) * Math.PI) : 0;
        tt.lift = w * 0.18;
        if (w > 0.85 && tt.flash < 0.3) tt.flash = 0.45;
      } else tt.lift *= 0.9;
      tt.flash = Math.max(0, tt.flash - dt * 1.4);
      writeTile(i);
    }
    tiles.instanceMatrix.needsUpdate = true;
    tiles.instanceColor.needsUpdate = true;

    arcs.forEach((a) => {
      a.age += dt;
      const life = a.age / a.life;
      a.mesh.material.uniforms.uTime.value = t;
      a.mesh.material.uniforms.uLife.value = Math.sin(clamp01(life) * Math.PI);
      if (life >= 1) {
        // the pair decoheres; both ends flip, then a new pair entangles
        for (const k of [a.i, a.j]) { const tt = T[k]; if (tt.flip < 0) { tt.next = tt.state === 1 ? 0 : 1; tt.flip = 0; tt.flash = 0.8; } }
        placeArc(a);
      }
    });

    stepBloch(blochA, t, 1.25, 1.05);
    stepBloch(blochB, t + 4, -1.7, 1.9);
    blochA.g.position.y = 2.1 + Math.sin(t * 0.7) * 0.1;
    blochB.g.position.y = -0.15 + Math.sin(t * 0.9 + 1) * 0.08;
    blochA.g.rotation.y = t * 0.12;
    blochB.g.rotation.y = -t * 0.15;

    frostMat.uniforms.uTime.value = t;
    vapors.forEach((s) => {
      const u = s.userData;
      s.position.set(u.x + Math.sin(t * u.sp + u.ph) * 0.5, u.y - ((t * u.sp * 0.6) % 1) * 0.6, u.z);
      s.material.opacity = u.base * (0.6 + 0.4 * Math.sin(t * 0.5 + u.ph));
      s.material.rotation = t * 0.03 + u.ph;
    });

    // readout synced to Bloch sphere A: |psi> = cos(theta/2)|0> + e^{i phi} sin(theta/2)|1>
    if (frameNo++ % 4 === 0) {
      const a = Math.cos(blochA.theta / 2), b = Math.sin(blochA.theta / 2);
      const ph = ((blochA.phi % TAU) + TAU) % TAU;
      psiEl.innerHTML = `|ψ⟩ = ${a.toFixed(2)}|0⟩ + ${b.toFixed(2)}e<sup>i${ph.toFixed(2)}</sup>|1⟩`;
    }
  }

  function draw() {
    renderer.render(scene, camera);
    placeTags(W, Hh);
  }

  pose(0.0001);
  draw();
  host.classList.add("ready");

  const api = { measure };
  if (REDUCED) {
    new ResizeObserver(() => { fit(); draw(); }).observe(host);
    return api;
  }

  let visible = true, raf = 0;
  const t0 = performance.now();
  const loop = () => {
    raf = 0;
    if (!visible || document.hidden) return;
    pose((performance.now() - t0) / 1000);
    draw();
    raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(loop); };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }).observe(host);
  document.addEventListener("visibilitychange", kick);
  new ResizeObserver(() => { fit(); draw(); }).observe(host);
  kick();
  // let a headless capture drive time
  // (stills and films for the X kit move the camera and parts directly)
  window.__qgpu = { pose, draw, measure, fit, camera, LOOK, scene, rig, machine, fridge, card, floor, T, cores, blochA, blochB, hud, pointer, renderer };
  return api;
}
