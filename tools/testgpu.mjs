import { createRequire } from "module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const url = process.argv[2] || "http://127.0.0.1:9160/_test/engine.html";
const b = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: "new",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage();
p.on("pageerror", e => console.log("PAGEERR", e.message));
p.on("console", m => { if (m.type() !== "log") console.log(m.type(), m.text()); });
await p.goto(url);
await p.waitForFunction("window.__done === true", { timeout: 120000 }).catch(e => console.log("timeout"));
console.log(await p.$eval("#o", e => e.textContent));
await b.close();
