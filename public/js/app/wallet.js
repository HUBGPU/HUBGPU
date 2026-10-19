// Wallet: EIP-6963 discovery, connect sheet, switch to Robinhood Chain. Every write is signed in the visitor's wallet.
import { getAddress } from "/vendor/ethers.min.js";

const CFG = window.HUBGPU_CONFIG;
export const CHAIN = CFG.chain;
const found = new Map();
addEventListener("eip6963:announceProvider", (e) => found.set(e.detail.info.uuid, e.detail));
dispatchEvent(new Event("eip6963:requestProvider"));
const list = () => {
  const l = [...found.values()].filter((w) => !/phantom/i.test(w.info.name));
  if (!l.length && window.ethereum) l.push({ info: { name: "Browser wallet", icon: "", uuid: "inj" }, provider: window.ethereum });
  return l;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

const subs = new Set();
export const wallet = {
  provider: null, address: null,
  on(fn) { subs.add(fn); fn(this.address); return () => subs.delete(fn); },
  emit() { for (const f of subs) { try { f(this.address); } catch { /* listener */ } } },
};

function sheet(html, onClose) {
  let el = document.getElementById("sheet");
  if (!el) { el = document.createElement("div"); el.id = "sheet"; document.body.append(el); }
  el.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-card">${html}</div>`;
  el.hidden = false;
  el.onclick = (e) => { if (e.target.closest("[data-close]")) { el.hidden = true; onClose?.(); } };
  return el;
}
export const closeSheet = () => { const el = document.getElementById("sheet"); if (el) el.hidden = true; };
export { sheet };

let pending = null;
export function connect() {
  if (wallet.address) return Promise.resolve(wallet.address);
  pending ??= new Promise((resolve, reject) => {
    const ws = list();
    const el = sheet(`<button class="sheet-x" data-close aria-label="Close">×</button><h2>Connect a wallet</h2>
      <p class="sub">Launches and trades are signed in your own wallet. HubGPU switches it to ${esc(CHAIN.label)}.</p>
      <div class="wlist">${ws.length
        ? ws.map((w, i) => `<button type="button" data-w="${i}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : `<span class="ph"></span>`}${esc(w.info.name)}<small>detected</small></button>`).join("")
        : `<a href="https://metamask.app.link/dapp/${esc(location.host + location.pathname)}"><span class="ph"></span>Open in MetaMask<small>app</small></a>
           <p class="sub">On a computer, install MetaMask or Rabby and reload this page.</p>`}</div>`,
    () => { pending = null; reject(Object.assign(new Error("You closed the wallet window."), { code: 4001 })); });
    el.querySelectorAll("[data-w]").forEach((b) => (b.onclick = async () => {
      try {
        const p = ws[+b.dataset.w].provider;
        const [a] = await p.request({ method: "eth_requestAccounts" });
        wallet.provider = p; wallet.address = getAddress(a);
        try { localStorage.setItem("hub.wallet", "1"); } catch { /* private mode */ }
        p.on?.("accountsChanged", (x) => { wallet.address = x[0] ? getAddress(x[0]) : null; wallet.emit(); });
        await ensureChain().catch(() => {});
        closeSheet(); pending = null; wallet.emit();
        resolve(wallet.address);
      } catch (e) { b.querySelector("small").textContent = e?.code === 4001 ? "cancelled" : "could not connect"; }
    }));
  });
  return pending;
}

export async function ensureChain() {
  const id = await wallet.provider.request({ method: "eth_chainId" });
  if (parseInt(id, 16) === CHAIN.id) return;
  try { await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] }); }
  catch (e) {
    if (e?.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message || "")) {
      await wallet.provider.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN.hex, chainName: CHAIN.label, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: CHAIN.rpc, blockExplorerUrls: [CHAIN.explorer] }] });
    } else throw e;
  }
}
export function disconnect() { wallet.provider = null; wallet.address = null; try { localStorage.removeItem("hub.wallet"); } catch { /* private mode */ } wallet.emit(); }

// reconnect silently when this browser connected before
setTimeout(async () => {
  let was = null; try { was = localStorage.getItem("hub.wallet"); } catch { /* private mode */ }
  const w = was && list()[0];
  if (!w) return;
  try {
    const [a] = await w.provider.request({ method: "eth_accounts" });
    if (a) { wallet.provider = w.provider; wallet.address = getAddress(a); w.provider.on?.("accountsChanged", (x) => { wallet.address = x[0] ? getAddress(x[0]) : null; wallet.emit(); }); wallet.emit(); }
  } catch { /* wallet locked */ }
}, 300);

/** the header button: Connect / 0x12…abcd (click to disconnect) */
export function mountWalletButton(btn) {
  wallet.on((a) => { btn.textContent = a ? short(a) : "Connect wallet"; btn.classList.toggle("on", !!a); });
  btn.onclick = () => (wallet.address ? (confirm("Disconnect " + short(wallet.address) + "?") && disconnect()) : connect().catch(() => {}));
}
