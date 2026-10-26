// Brand, token, chain and launch rules. Edit here only; an empty CA shows "Coming soon".
window.HUBGPU_CONFIG = {
  name: "HubGPU",
  ticker: "$HGPU",
  domain: "hubgpu.network",
  ca: "",
  buyUrl: "",        // e.g. https://www.ponsfamily.com/launchpad/<CA>
  x: "https://x.com/hubgpunetwork",
  telegram: "https://t.me/hubgpunetwork",
  github: "https://github.com/HUBGPU/HUBGPU",

  /* Launchpad: every token is born from a measurement on the creator's own GPU, then launched on Pons */
  launch: {
    tag: "Born on HubGPU",            // written at the end of every token description, with the measured bitstring
    qubits: 12,                       // size of the birth circuit
    depth: 10,
    minBuyEth: 0.0001,                // the creator's first buy is required; this is the smallest allowed
    buyPresets: [0.0001, 0.001, 0.005, 0.01, 0.05],
    taxOptions: [0, 1, 2, 3, 5],      // creator tax %, paid to the creator on every trade (Pons allows up to 10%)
    supply: 1000000000,
    curve: { phantomEth: 1.68, graduationEth: 4.2, feeBps: 100 },   // Pons v2, read from the contracts
  },

  /* HubGPU launchpad contract (Robinhood Chain). Empty = launches go straight to Pons with no HubGPU fee. */
  launchpad: {
    address: "0xb6b5f0E3c1f34d99b55c8a406Ee3A21580AF2380",                      // HubGPULaunchpad, set after the owner deploys it
    block: 92483377,                         // its deploy block: from here on, only launches through it are listed
  },

  /* $HGPU utility: checked on-chain against the wallet's live balance. Unlocks once `ca` is set. */
  holder: {
    rare: 1000000,                    // hold this much $HGPU to birth from 16 qubits (rare seal) and launch with no HubGPU fee
    featured: 5000000,                // creators holding this much get their tokens in the Featured row
  },

  chain: {
    label: "Robinhood Chain",
    id: 4663,
    hex: "0x1237",
    rpc: ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
    explorer: "https://robinhoodchain.blockscout.com",
    pons: "https://www.ponsfamily.com/launchpad",
    bridge: "https://jumper.exchange/?fromChain=8453&fromToken=0x0000000000000000000000000000000000000000&toChain=4663&toToken=0x0000000000000000000000000000000000000000",
  },
};
