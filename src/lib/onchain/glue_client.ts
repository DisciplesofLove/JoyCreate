/**
 * Thin ethers wrapper around the JOY Marketplace glue Stylus contracts:
 *   - StoreRegistry     (storefront directory + ERC-8004 binding)
 *   - EditionController (drop factory + PoU-gated mint)
 *   - AgentMandate      (delegated spend limits / action scope / time-gate)
 *
 * Used by `src/ipc/handlers/glue_handlers.ts`. Writes require a signing
 * `Wallet`; reads only need a provider. Store slugs are stored on-chain as
 * raw bytes (Stylus has no `string` type), so this layer encodes/decodes
 * UTF-8 at the boundary.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  AGENT_MANDATE_ABI,
  EDITION_CONTROLLER_ABI,
  GLUE_RPC,
  STORE_REGISTRY_ABI,
  type GlueChainId,
  getAgentMandateAddress,
  getEditionControllerAddress,
  getStoreRegistryAddress,
  isGlueReady,
} from "@/config/glue";

const logger = log.scope("glue_client");

// Arbitrum Sepolia base fee floats low; these overrides keep txs cheap.
const TX_OVERRIDES = {
  maxFeePerGas: 200_000_000n,
  maxPriorityFeePerGas: 100_000n,
};

function requireReady(chain: GlueChainId): void {
  if (!isGlueReady(chain)) {
    throw new Error(
      `Glue contracts not deployed on ${chain} — fill addresses in src/config/glue.ts`,
    );
  }
}

export function makeProvider(chain: GlueChainId): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(GLUE_RPC[chain]);
}

function storeContract(
  chain: GlueChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  return new ethers.Contract(
    getStoreRegistryAddress(chain),
    STORE_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

function editionContract(
  chain: GlueChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  return new ethers.Contract(
    getEditionControllerAddress(chain),
    EDITION_CONTROLLER_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

function mandateContract(
  chain: GlueChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  return new ethers.Contract(
    getAgentMandateAddress(chain),
    AGENT_MANDATE_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

function parseEmittedId(
  contract: ethers.Contract,
  receipt: ethers.TransactionReceipt | null,
  eventName: string,
  argName: string,
): string {
  if (!receipt) return "";
  const iface = contract.interface;
  for (const lg of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics as string[], data: lg.data });
      if (parsed?.name === eventName) {
        return (parsed.args[argName] as bigint).toString();
      }
    } catch {
      // not one of our events
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// StoreRegistry
// ---------------------------------------------------------------------------

export interface StoreRecord {
  storeId: string;
  owner: string;
  agentId: string;
  slug: string;
}

export async function registerStore(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; slug: string; agentId: string },
): Promise<{ storeId: string; txHash: string; blockNumber: number }> {
  if (!input.slug) throw new Error("slug is required");
  const contract = storeContract(input.chain, wallet);
  const slugBytes = ethers.toUtf8Bytes(input.slug);
  const tx = await contract.registerStore(slugBytes, input.agentId ?? "0", TX_OVERRIDES);
  logger.info("registerStore tx", tx.hash);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("registerStore tx receipt was null");
  const storeId = parseEmittedId(contract, receipt, "StoreRegistered", "storeId");
  return { storeId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export async function setStoreAgent(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; storeId: string; agentId: string },
): Promise<{ txHash: string }> {
  const contract = storeContract(input.chain, wallet);
  const tx = await contract.setAgent(input.storeId, input.agentId, TX_OVERRIDES);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("setAgent tx receipt was null");
  return { txHash: receipt.hash };
}

export async function transferStore(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; storeId: string; newOwner: string },
): Promise<{ txHash: string }> {
  if (!ethers.isAddress(input.newOwner)) throw new Error("newOwner is not a valid address");
  const contract = storeContract(input.chain, wallet);
  const tx = await contract.transferStore(input.storeId, input.newOwner, TX_OVERRIDES);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("transferStore tx receipt was null");
  return { txHash: receipt.hash };
}

export async function getStore(
  chain: GlueChainId,
  storeId: string,
): Promise<StoreRecord> {
  const contract = storeContract(chain);
  const [id, owner, agentId, slugBytes] = await contract.getStore(storeId);
  return {
    storeId: (id as bigint).toString(),
    owner: owner as string,
    agentId: (agentId as bigint).toString(),
    slug: ethers.toUtf8String(slugBytes as string),
  };
}

export async function resolveStoreBySlug(
  chain: GlueChainId,
  slug: string,
): Promise<string> {
  const contract = storeContract(chain);
  const slugHash = ethers.keccak256(ethers.toUtf8Bytes(slug));
  const id = await contract.resolveBySlugHash(slugHash);
  return (id as bigint).toString();
}

export async function storeCount(chain: GlueChainId): Promise<string> {
  const contract = storeContract(chain);
  return ((await contract.storeCount()) as bigint).toString();
}

// ---------------------------------------------------------------------------
// EditionController
// ---------------------------------------------------------------------------

export interface DropRecord {
  dropId: string;
  creator: string;
  storeId: string;
  assetLeaf: string;
  price: string;
  maxSupply: string;
  minted: string;
  active: boolean;
  requiresProof: boolean;
}

export async function createDrop(
  wallet: ethers.Wallet,
  input: {
    chain: GlueChainId;
    storeId: string;
    assetLeaf: string;
    price?: string;
    maxSupply?: string;
    requiresProof?: boolean;
  },
): Promise<{ dropId: string; txHash: string; blockNumber: number }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.assetLeaf)) {
    throw new Error("assetLeaf must be a 0x-prefixed 32-byte hex string");
  }
  const contract = editionContract(input.chain, wallet);
  const tx = await contract.createDrop(
    input.storeId,
    input.assetLeaf,
    input.price ?? "0",
    input.maxSupply ?? "0",
    input.requiresProof ?? false,
    TX_OVERRIDES,
  );
  logger.info("createDrop tx", tx.hash);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("createDrop tx receipt was null");
  const dropId = parseEmittedId(contract, receipt, "DropCreated", "dropId");
  return { dropId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export async function setDropActive(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; dropId: string; active: boolean },
): Promise<{ txHash: string }> {
  const contract = editionContract(input.chain, wallet);
  const tx = await contract.setActive(input.dropId, input.active, TX_OVERRIDES);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("setActive tx receipt was null");
  return { txHash: receipt.hash };
}

export async function grantProof(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; dropId: string; account: string },
): Promise<{ txHash: string }> {
  if (!ethers.isAddress(input.account)) throw new Error("account is not a valid address");
  const contract = editionContract(input.chain, wallet);
  const tx = await contract.grantProof(input.dropId, input.account, TX_OVERRIDES);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("grantProof tx receipt was null");
  return { txHash: receipt.hash };
}

export async function mintEdition(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; dropId: string },
): Promise<{ tokenId: string; txHash: string; blockNumber: number }> {
  const contract = editionContract(input.chain, wallet);
  const tx = await contract.mint(input.dropId, TX_OVERRIDES);
  logger.info("mint tx", tx.hash);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("mint tx receipt was null");
  const tokenId = parseEmittedId(contract, receipt, "Minted", "tokenId");
  return { tokenId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export async function getDrop(chain: GlueChainId, dropId: string): Promise<DropRecord> {
  const contract = editionContract(chain);
  const [creator, storeId, assetLeaf, price, maxSupply, minted, active, requiresProof] =
    await contract.getDrop(dropId);
  return {
    dropId,
    creator: creator as string,
    storeId: (storeId as bigint).toString(),
    assetLeaf: assetLeaf as string,
    price: (price as bigint).toString(),
    maxSupply: (maxSupply as bigint).toString(),
    minted: (minted as bigint).toString(),
    active: active as boolean,
    requiresProof: requiresProof as boolean,
  };
}

export async function editionBalanceOf(
  chain: GlueChainId,
  dropId: string,
  account: string,
): Promise<string> {
  const contract = editionContract(chain);
  return ((await contract.balanceOf(dropId, account)) as bigint).toString();
}

export async function dropCount(chain: GlueChainId): Promise<string> {
  const contract = editionContract(chain);
  return ((await contract.dropCount()) as bigint).toString();
}

// ---------------------------------------------------------------------------
// AgentMandate
// ---------------------------------------------------------------------------

export interface MandateRecord {
  mandateId: string;
  principal: string;
  agent: string;
  spendLimit: string;
  spent: string;
  expiry: string;
  actionScope: string;
  active: boolean;
}

export async function createMandate(
  wallet: ethers.Wallet,
  input: {
    chain: GlueChainId;
    agent: string;
    spendLimit: string;
    expiry?: string;
    actionScope?: string;
  },
): Promise<{ mandateId: string; txHash: string; blockNumber: number }> {
  if (!ethers.isAddress(input.agent)) throw new Error("agent is not a valid address");
  const scope = input.actionScope ?? ethers.ZeroHash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(scope)) {
    throw new Error("actionScope must be a 0x-prefixed 32-byte hex string");
  }
  const contract = mandateContract(input.chain, wallet);
  const tx = await contract.createMandate(
    input.agent,
    input.spendLimit,
    input.expiry ?? "0",
    scope,
    TX_OVERRIDES,
  );
  logger.info("createMandate tx", tx.hash);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("createMandate tx receipt was null");
  const mandateId = parseEmittedId(contract, receipt, "MandateCreated", "mandateId");
  return { mandateId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export async function recordSpend(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; mandateId: string; amount: string },
): Promise<{ txHash: string }> {
  const contract = mandateContract(input.chain, wallet);
  const tx = await contract.recordSpend(input.mandateId, input.amount, TX_OVERRIDES);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("recordSpend tx receipt was null");
  return { txHash: receipt.hash };
}

export async function revokeMandate(
  wallet: ethers.Wallet,
  input: { chain: GlueChainId; mandateId: string },
): Promise<{ txHash: string }> {
  const contract = mandateContract(input.chain, wallet);
  const tx = await contract.revokeMandate(input.mandateId, TX_OVERRIDES);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("revokeMandate tx receipt was null");
  return { txHash: receipt.hash };
}

export async function isMandateValid(
  chain: GlueChainId,
  mandateId: string,
): Promise<boolean> {
  const contract = mandateContract(chain);
  return (await contract.isValid(mandateId)) as boolean;
}

export async function canSpend(
  chain: GlueChainId,
  mandateId: string,
  amount: string,
): Promise<boolean> {
  const contract = mandateContract(chain);
  return (await contract.canSpend(mandateId, amount)) as boolean;
}

export async function getMandate(
  chain: GlueChainId,
  mandateId: string,
): Promise<MandateRecord> {
  const contract = mandateContract(chain);
  const [principal, agent, spendLimit, spent, expiry, actionScope, active] =
    await contract.getMandate(mandateId);
  return {
    mandateId,
    principal: principal as string,
    agent: agent as string,
    spendLimit: (spendLimit as bigint).toString(),
    spent: (spent as bigint).toString(),
    expiry: (expiry as bigint).toString(),
    actionScope: actionScope as string,
    active: active as boolean,
  };
}

export async function mandateCount(chain: GlueChainId): Promise<string> {
  const contract = mandateContract(chain);
  return ((await contract.mandateCount()) as bigint).toString();
}
