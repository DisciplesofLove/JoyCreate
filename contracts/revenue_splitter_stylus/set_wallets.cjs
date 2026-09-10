// Update the RevenueSplitter fee wallets (Phase 1 wallet hardening).
// Reads owner private key from .pk.txt in the same directory.
// Usage:
//   node set_wallets.cjs <splitterAddress> <platformDaoTreasury> <computeWallet>
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

const RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const ABI = [
  "function owner() view returns (address)",
  "function setWallets(address platformWallet, address protocolWallet) returns (bool)",
  "function getConfig() view returns (address, address, address, uint256, uint256, uint256)",
];

function printConfig(label, cfg) {
  console.log(`${label}:`);
  console.log("  usdc/token     :", cfg[0]);
  console.log("  platformWallet :", cfg[1], "(Platform + DAO treasury)");
  console.log("  protocolWallet :", cfg[2], "(Compute / Lit fee)");
  console.log("  bps            :", cfg[3].toString(), cfg[4].toString(), cfg[5].toString());
}

async function main() {
  const [, , splitterAddr, platformDao, compute] = process.argv;
  if (!splitterAddr || !platformDao || !compute) {
    console.error("usage: node set_wallets.cjs <splitter> <platformDaoTreasury> <computeWallet>");
    process.exit(1);
  }
  if (platformDao.toLowerCase() === compute.toLowerCase()) {
    console.error("refusing: platformDaoTreasury and computeWallet must be distinct addresses");
    process.exit(1);
  }
  const pk = fs.readFileSync(path.join(__dirname, ".pk.txt"), "utf8").trim();
  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
  console.log("from:", wallet.address);
  const c = new Contract(splitterAddr, ABI, wallet);

  const owner = await c.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`refusing: signer is not the splitter owner (owner=${owner})`);
    process.exit(1);
  }

  printConfig("before", await c.getConfig());

  const overrides = { maxFeePerGas: 100000000n, maxPriorityFeePerGas: 100000n };
  console.log("calling setWallets(platformDaoTreasury, computeWallet)...");
  const tx = await c.setWallets(platformDao, compute, overrides);
  console.log("setWallets tx:", tx.hash);
  const r = await tx.wait();
  console.log("confirmed in block", r.blockNumber);

  printConfig("after", await c.getConfig());
  console.log("\nNext: update docs/payments/deployments.json (walletsHardened: true) and split-config.json.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
