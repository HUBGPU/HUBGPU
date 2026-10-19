# Security

HubGPU's launchpad contract keeps no funds and has no function that can move a creator's ETH, tokens or creator fees. The owner can only change bounded settings (launch fee up to 0.01 ETH, treasury, minimum first buy, $HGPU holder terms, fee-exempt list, pause).

If you find a problem in the contract, the server or the pages, please report it privately before disclosing it: send a direct message to [@hubgpunetwork](https://x.com/hubgpunetwork) on X with a short description and how to reproduce it.

Please do not test against other users' tokens or funds. A fork of Robinhood Chain (`anvil --fork-url https://rpc.mainnet.chain.robinhood.com`) and `tools/e2e-launch.mjs` reproduce the full launch path locally.
