// Local fork test of the launchpad, run against a server whose RPC_URL is an anvil fork of Robinhood Chain.
//   node tools/e2e-launch.mjs <mode> <server> <anvil> <address> <outdir> [symbol] [buyEth]
//   mode launch : birth + launch a token, open its page, buy on the curve
//   mode rare   : expects the $HGPU holder toggle, births a 16-qubit token and launches it
//   mode mine   : My tokens tab, claim creator fees
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const [mode, base, anvil, addr, out, sym = "SCAT", buyEth = "0.01"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new", protocolTimeout: 900000,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
p.on("pageerror", (e) => console.log("PAGEERR", e.message));
p.on("console", (m) => { if (m.type() === "error" && !/ERR_BLOCKED|ipfs|Failed to load resource/.test(m.text())) console.log("console", m.text()); });
await p.evaluateOnNewDocument((anvil, addr) => {
  localStorage.setItem("hub.wallet", "1");
  window.ethereum = { isMetaMask: true, on() {}, request: async ({ method, params }) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
    if (method === "eth_chainId") return "0x1237";
    if (method === "wallet_switchEthereumChain") return null;
    const r = await fetch(anvil, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw j.error; return j.result;
  } };
}, anvil, addr);
const api = async (path) => (await fetch(base + path)).json();

async function birthAndLaunch() {
  await p.goto(base + "/app", { waitUntil: "load" });
  await p.waitForFunction(() => !document.querySelector("#device-label").textContent.startsWith("Looking"), { timeout: 30000 });
  await sleep(1500);
  console.log("HOLDER:", await p.$eval("#holder", (e) => e.textContent.trim().replace(/\s+/g, " ")));
  await p.type("#f-name", sym === "QBIT" ? "Entangled Pair" : "Schrodinger Cat"); await p.type("#f-sym", sym);
  await sleep(700);
  await p.click("#w-next");                                   // step 2 runs the machine by itself
  await p.waitForFunction(() => !document.querySelector("#f-again").hidden, { timeout: 60000 });
  console.log("BIRTH:", await p.$eval("#b-bits", (e) => e.textContent), await p.$eval("#b-c", (e) => e.textContent), "rare:", await p.$eval("#birth", (e) => e.classList.contains("rare")));
  await p.click("#w-next");
  await p.type("#f-desc", "Local fork test of the HubGPU launch path.");
  await p.type("#f-x", "@hubgpunetwork"); await p.type("#f-tg", "t.me/hubgputest");
  await p.click("#w-next"); await sleep(2500);
  console.log("COST:", await p.$$eval("#cost tr", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()).join(" | ")));
  await p.click("#f-launch");
  for (let i = 0; i < 100; i++) {
    const s = await p.$$eval("#f-log li", (els) => els.map((e) => e.textContent.trim()).join(" | "));
    if (!(await p.$eval('[data-step="5"]', (e) => e.hidden)) || (await p.$("#f-log li.bad"))) break;
    if (i % 6 === 0) console.log("  …", s.split(" | ").pop());
    await sleep(5000);
  }
  console.log("LOG:", await p.$$eval("#f-log li", (els) => els.map((e) => e.textContent.trim()).join(" | ")));
  console.log("SUCCESS:", await p.$eval("#d-title", (e) => e.textContent), "| CA", await p.$eval("#d-ca", (e) => e.textContent), "| share", (await p.$eval("#d-share", (e) => e.href)).slice(0, 90));
  await (await p.$("#create")).screenshot({ path: `${out}/e2e-${mode}-done.png` });
  const j = await api("/api/launches");
  const t = j.launches.find((l) => l.symbol === sym);
  console.log("REGISTRY:", JSON.stringify(t && { symbol: t.symbol, token: t.token, bits: t.bits, rare: t.rare, featured: t.featured, creator: t.creator }));
  return t;
}

if (mode === "launch" || mode === "rare") {
  const t = await birthAndLaunch();
  if (t && mode === "launch") {
    await p.goto(`${base}/t/${t.token}`, { waitUntil: "load" });
    await p.waitForSelector('[data-k="amt"]', { timeout: 30000 });
    await sleep(3000);
    await p.type('[data-k="amt"]', buyEth);
    await sleep(800);
    console.log("QUOTE:", await p.$eval('[data-k="quote"]', (e) => e.textContent));
    await p.click('[data-k="go"]');
    await p.waitForFunction(() => /Done|fail|cancel|Not enough|would/i.test(document.querySelector('[data-k="msg"]').textContent), { timeout: 180000 });
    console.log("BUY:", await p.$eval('[data-k="msg"]', (e) => e.textContent), "|", await p.$eval('[data-k="pos"]', (e) => e.textContent));
    await sleep(14000);
    console.log("TRADES:", await p.$$eval(".ttr", (els) => els.length), "rows");
    await p.screenshot({ path: `${out}/e2e-token.png`, fullPage: true });
    const born = await fetch(`${base}/t/${t.token}`, { redirect: "manual" });
    console.log("TOKEN PAGE:", born.status);
  }
}
if (mode === "mine") {
  await p.goto(base + "/app#mine", { waitUntil: "load" });
  await p.waitForFunction(() => /ETH/.test(document.querySelector("#m-fee").textContent), { timeout: 30000 });
  console.log("MINE:", await p.$eval("#m-count", (e) => e.textContent), "| fee:", await p.$eval("#m-fee", (e) => e.textContent), "|", await p.$eval("#m-holder", (e) => e.textContent.trim()));
  await p.click("#m-claim");
  await p.waitForFunction(() => document.querySelector("#m-log li.ok, #m-log li.bad"), { timeout: 240000 });
  console.log("CLAIM:", await p.$$eval("#m-log li", (els) => els.map((e) => e.textContent.trim()).join(" | ")));
  await sleep(1500);
  await p.screenshot({ path: `${out}/e2e-mine.png`, fullPage: true });
}
await b.close();
