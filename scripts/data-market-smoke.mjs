#!/usr/bin/env node
/**
 * Data Market end-to-end smoke test (Arbitrum Sepolia).
 *
 * Hits the live Stylus contracts directly via ethers — no Electron / IPC.
 *
 *   1. Mint a Provenance token with a random merkle root + human proof.
 *   2. Create a listing referencing that token.
 *   3. Purchase the lease from the same wallet.
 *   4. Assert `hasActiveLease(listingId, wallet) === true`.
 *
 * Run with: BURNER_PK=<hex> node scripts/data-market-smoke.mjs
 *   or: drop a `.pk.txt` at the repo root containing the key.
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
const PROVENANCE = "0xe6c66de70de8cfba8129db78ff81d36d7de0ccb8";
const LEASE = "0xa3aab9773b8f354aadc2489281aa232b03cacd71";

const PROVENANCE_ABI = [
  "function mintProvenance(bytes32 merkleRoot, bytes contentURI, bytes32 humanProof) returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function creatorOf(uint256) view returns (address)",
  "event ProvenanceMinted(uint256 indexed tokenId, address indexed creator, bytes32 indexed merkleRoot, bytes32 humanProof, bytes contentURI, uint256 mintedAt)",
];

const LEASE_ABI = [
  "function createListing(uint256 tokenId, uint256 priceWei, uint256 durationSecs, bytes32 accConditionsHash) returns (uint256)",
  "function purchaseLease(uint256 listingId) payable returns (uint256)",
  "function hasActiveLease(uint256 listingId, address lessee) view returns (bool)",
  "event ListingCreated(uint256 indexed listingId, address indexed creator, uint256 indexed tokenId, uint256 priceWei, uint256 durationSecs, bytes32 accConditionsHash)",
  "event LeaseGranted(uint256 indexed leaseId, uint256 indexed listingId, address indexed lessee, uint256 tokenId, uint256 paidWei, uint256 expiresAt, bytes32 accConditionsHash)",
];

const TX_OVERRIDES = {
  maxFeePerGas: 200_000_000n,
  maxPriorityFeePerGas: 100_000n,
};

function loadKey() {
  if (process.env.BURNER_PK) return process.env.BURNER_PK.trim();
  const pkPath = path.resolve(process.cwd(), ".pk.txt");
  if (fs.existsSync(pkPath)) return fs.readFileSync(pkPath, "utf8").trim();
  throw new Error("set BURNER_PK env var or create .pk.txt at repo root");
}

function findEvent(receipt, iface, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch {
      /* not for this iface */
    }
  }
  return null;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(loadKey(), provider);
  console.log("[smoke] wallet", wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log("[smoke] balance", ethers.formatEther(bal), "ETH");
  if (bal < ethers.parseEther("0.005"))
    throw new Error("insufficient ETH for smoke test (need ~0.005)");

  const prov = new ethers.Contract(PROVENANCE, PROVENANCE_ABI, wallet);
  const lease = new ethers.Contract(LEASE, LEASE_ABI, wallet);
  const provIface = new ethers.Interface(PROVENANCE_ABI);
  const leaseIface = new ethers.Interface(LEASE_ABI);

  // 1. Mint provenance
  const merkleRoot = ethers.hexlify(ethers.randomBytes(32));
  const humanProof = ethers.hexlify(ethers.randomBytes(32));
  const contentUri = `ipfs://smoke-test-${Date.now()}`;
  console.log("\n[1/4] mintProvenance");
  console.log("       merkleRoot:", merkleRoot);
  console.log("       contentUri:", contentUri);
  const tx1 = await prov.mintProvenance(
    merkleRoot,
    ethers.toUtf8Bytes(contentUri),
    humanProof,
    TX_OVERRIDES,
  );
  console.log("       tx:", tx1.hash);
  const r1 = await tx1.wait();
  const minted = findEvent(r1, provIface, "ProvenanceMinted");
  if (!minted) throw new Error("ProvenanceMinted not found in receipt logs");
  const tokenId = minted.args.tokenId;
  console.log("       tokenId:", tokenId.toString());

  // 2. Create listing
  const priceWei = ethers.parseEther("0.0001");
  const durationSecs = 3600n;
  const accConditionsHash = ethers.hexlify(ethers.randomBytes(32));
  console.log("\n[2/4] createListing");
  const tx2 = await lease.createListing(
    tokenId,
    priceWei,
    durationSecs,
    accConditionsHash,
    TX_OVERRIDES,
  );
  console.log("       tx:", tx2.hash);
  const r2 = await tx2.wait();
  const created = findEvent(r2, leaseIface, "ListingCreated");
  if (!created) throw new Error("ListingCreated not found in receipt logs");
  const listingId = created.args.listingId;
  console.log("       listingId:", listingId.toString());

  // 3. Purchase lease
  console.log("\n[3/4] purchaseLease");
  const tx3 = await lease.purchaseLease(listingId, {
    ...TX_OVERRIDES,
    value: priceWei,
  });
  console.log("       tx:", tx3.hash);
  const r3 = await tx3.wait();
  const granted = findEvent(r3, leaseIface, "LeaseGranted");
  if (!granted) throw new Error("LeaseGranted not found in receipt logs");
  console.log("       leaseId:", granted.args.leaseId.toString());
  console.log(
    "       expiresAt:",
    new Date(Number(granted.args.expiresAt) * 1000).toISOString(),
  );

  // 4. Assert hasActiveLease
  console.log("\n[4/4] hasActiveLease");
  const active = await lease.hasActiveLease(listingId, wallet.address);
  console.log("       active:", active);
  if (!active)
    throw new Error("hasActiveLease returned false after successful purchase");

  console.log("\n[smoke] ✅ all assertions passed");
}

main().catch((err) => {
  console.error("\n[smoke] ❌", err);
  process.exit(1);
});
