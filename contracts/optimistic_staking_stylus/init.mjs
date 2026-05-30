// One-off initializer for OptimisticStaking on Arbitrum Sepolia.
// Usage: node init.mjs
import { readFileSync } from "node:fs";
import { ethers } from "ethers";

const RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const CONTRACT = "0x5f587e50a9de2409e5f43d70dc0a22b88bf61904";
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"; // Arb Sepolia USDC (6dp)

const pkRaw = readFileSync(new URL("./.pk.txt", import.meta.url), "utf8").trim();
const pk = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(pk, provider);

const abi = [
  "function initialize(address stakeToken, address arbiter, uint256 minStake, uint256 challengeWindow) external",
  "function getConfig() view returns (address owner, address arbiter, address stakeToken, uint256 minStake, uint256 challengeWindow)",
];

const c = new ethers.Contract(CONTRACT, abi, wallet);

const arbiter = wallet.address; // owner is arbiter on testnet
const minStake = 1_000_000n; // 1 USDC (6 decimals)
const challengeWindow = 300n; // 5 minutes (testnet)

console.log("owner/arbiter:", arbiter);
const tx = await c.initialize(USDC, arbiter, minStake, challengeWindow, {
  maxFeePerGas: ethers.parseUnits("1", "gwei"),
  maxPriorityFeePerGas: ethers.parseUnits("0.1", "gwei"),
});
console.log("initialize tx:", tx.hash);
await tx.wait();
const cfg = await c.getConfig();
console.log("config:", {
  owner: cfg[0],
  arbiter: cfg[1],
  stakeToken: cfg[2],
  minStake: cfg[3].toString(),
  challengeWindow: cfg[4].toString(),
});
