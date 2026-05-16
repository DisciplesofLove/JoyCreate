// One-shot script to initialize the freshly deployed Stylus DropEdition.
// Reads private key from .pk.txt in the same directory.
// Usage:
//   node initialize.cjs <contractAddress> <ownerAddress> <mintPriceWei> [activate]
const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Wallet, Contract } = require("ethers");

const RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const ABI = [
  "function initialize(address owner, uint256 mint_price)",
  "function owner() view returns (address)",
  "function mintActive() view returns (bool)",
  "function setMintState(bool active)",
];

async function main() {
  const [, , contractAddr, ownerAddr, priceWei, activate] = process.argv;
  if (!contractAddr || !ownerAddr || !priceWei) {
    console.error("usage: node initialize.cjs <contract> <owner> <priceWei> [activate]");
    process.exit(1);
  }
  const pk = fs.readFileSync(path.join(__dirname, ".pk.txt"), "utf8").trim();
  const provider = new JsonRpcProvider(RPC);
  const wallet = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
  console.log("from:", wallet.address);
  const c = new Contract(contractAddr, ABI, wallet);

  const overrides = { maxFeePerGas: 100000000n, maxPriorityFeePerGas: 100000n };
  console.log("calling initialize...");
  const tx = await c.initialize(ownerAddr, BigInt(priceWei), overrides);
  console.log("initialize tx:", tx.hash);
  const r = await tx.wait();
  console.log("initialized in block", r.blockNumber);
  console.log("owner:", await c.owner());

  if (activate === "activate") {
    console.log("calling setMintState(true)...");
    const tx2 = await c.setMintState(true, overrides);
    console.log("setMintState tx:", tx2.hash);
    await tx2.wait();
    console.log("mintActive:", await c.mintActive());
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
