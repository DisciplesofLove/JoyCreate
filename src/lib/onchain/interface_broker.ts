/**
 * ERC-1144 Interface Broker — off-chain composition layer that emits a
 * machine-readable "Agent Interface Blueprint" for a marketplace resource.
 *
 * A blueprint tells a consuming agent everything it needs to discover, pay for
 * and invoke a resource (a store, a drop, or an agent), composing:
 *   - identity     — ERC-8004 agentId / domain / address (+ optional ENS name)
 *   - reputation   — ReputationRegistry score for the serving agent
 *   - store        — StoreRegistry record (slug, owner, agentId)
 *   - capability   — EditionController drop (price, supply, proof gating)
 *   - payment      — X402 PaymentRequirements (scheme=exact USDC → splitter)
 *   - invocation   — the IPC channels / future MCP tools that execute it
 *
 * This is the bridge between discovery (8004scan / ENS) and the X402 payment
 * rail: a blueprint's `payment` block is exactly what the payer signs against.
 */

import log from "electron-log";

import {
  atomicToUsdc,
  getRevenueSplitterAddress,
  getUsdcAddress,
  isX402Ready,
  type X402ChainId,
} from "@/config/x402";
import { createPaymentRequirements } from "@/lib/x402/server";
import type { PaymentRequirements } from "@/lib/x402/types";
import { isGlueReady } from "@/config/glue";
import type { DropRecord, StoreRecord } from "@/lib/onchain/glue_client";
import { getDropCached, getStoreCached } from "@/lib/onchain/subgraph_discovery";
import {
  getAgent,
  getReputationScore,
  makeProvider,
  type AgentRecord,
  type ReputationScore,
} from "@/lib/onchain/erc8004_client";
import { agentDomainToCardCid } from "@/lib/onchain/agent_card";
import { hashLicenseTerms, type LicenseTerms } from "@/lib/onchain/license";
import { storeName, assetName, resolveAddress } from "@/lib/onchain/ens_hierarchical";

const logger = log.scope("interface_broker");

/** Current interface-broker blueprint schema version. */
export const BLUEPRINT_VERSION = "erc1144/1.0";

export type BlueprintKind = "store" | "drop" | "agent";

export interface BlueprintIdentity {
  agentId: string;
  agentDomain: string;
  agentAddress: string;
  /** Fully-qualified ENS name when known. */
  ensName?: string;
  /** ENS-resolved address (CCIP-read) when available. */
  ensResolvedAddress?: string;
}

export interface BlueprintReputation {
  count: string;
  sum: string;
  average: number;
}

/**
 * Runtime manifest pointer derived from the identity's `agentDomain`. Present
 * only when the domain is an IPFS agent-card CID (not a legacy plain domain).
 * A consumer fetches the card to obtain modelConfig / systemPrompt / toolsSchema
 * / skillCID for local execution.
 */
export interface BlueprintRuntime {
  agentCardCid: string;
  agentCardUri: string;
}

/**
 * License node (LR2). Mirrors the structured `LicenseTerms` pinned in the drop
 * metadata so a consumer can check usage rights before purchase / runtime.
 */
export interface BlueprintLicense {
  id: string;
  spdx: string | null;
  commercial: boolean;
  derivative: boolean;
  runtimeExecution: boolean;
  expiry: string | null;
  seats: number | null;
  termsUri: string | null;
  /** keccak256 of the canonical terms, matching `metadata.licenseHash`. */
  hash: string;
}

export interface BlueprintCapability {
  /** Logical capability id (e.g. "mint", "inference"). */
  id: string;
  /** Human-readable label. */
  name: string;
  /** Price in human USDC (e.g. "0.25"), derived from atomic units. */
  priceUsdc: string;
  /** Price in atomic USDC base units. */
  priceAtomic: string;
  /** Whether proof-of-use must be granted before invocation. */
  requiresProof: boolean;
  /** The X402 payment requirements a consumer must satisfy. */
  payment: PaymentRequirements;
  /** How to invoke this capability from the desktop app. */
  invocation: {
    ipcChannel: string;
    /** Future MCP tool name (wired in P8). */
    mcpTool?: string;
    args: Record<string, string>;
  };
}

export interface InterfaceBlueprint {
  version: string;
  kind: BlueprintKind;
  chain: X402ChainId;
  /** Resource locator: store id, drop id, or agent id. */
  resourceId: string;
  identity?: BlueprintIdentity;
  reputation?: BlueprintReputation;
  /** Agent-card runtime manifest pointer, when the identity exposes one. */
  runtime?: BlueprintRuntime;
  /** Structured license terms (LR2), when the caller supplies them. */
  license?: BlueprintLicense;
  store?: StoreRecord & { ensName?: string };
  capabilities: BlueprintCapability[];
  /** Contract addresses referenced by this blueprint. */
  contracts: {
    revenueSplitter: string;
    usdc: string;
  };
  /** Whether all on-chain dependencies are deployed on this chain. */
  ready: boolean;
  generatedAt: string;
}

async function resolveIdentity(
  chain: X402ChainId,
  agentId: string,
  ensName?: string,
): Promise<BlueprintIdentity | undefined> {
  if (agentId === "0") return undefined;
  let agent: AgentRecord;
  try {
    agent = await getAgent(chain, agentId);
  } catch (err) {
    logger.warn(`identity lookup failed for agent ${agentId}: ${err}`);
    return undefined;
  }
  const identity: BlueprintIdentity = {
    agentId: agent.agentId,
    agentDomain: agent.agentDomain,
    agentAddress: agent.agentAddress,
    ensName,
  };
  if (ensName) {
    try {
      const provider = makeProvider(chain);
      const resolved = await resolveAddress(ensName, provider);
      if (resolved) identity.ensResolvedAddress = resolved;
    } catch {
      // CCIP resolution best-effort.
    }
  }
  return identity;
}

async function resolveReputation(
  chain: X402ChainId,
  agentId: string,
): Promise<BlueprintReputation | undefined> {
  if (agentId === "0") return undefined;
  try {
    const score: ReputationScore = await getReputationScore(chain, agentId);
    return { count: score.count, sum: score.sum, average: score.average };
  } catch (err) {
    logger.warn(`reputation lookup failed for agent ${agentId}: ${err}`);
    return undefined;
  }
}

/** Derive the runtime manifest pointer from a resolved identity, if any. */
function resolveRuntime(identity?: BlueprintIdentity): BlueprintRuntime | undefined {
  const cid = agentDomainToCardCid(identity?.agentDomain);
  if (!cid) return undefined;
  return { agentCardCid: cid, agentCardUri: `ipfs://${cid}` };
}

/** Project structured license terms onto a blueprint license node. */
function resolveLicense(terms?: LicenseTerms): BlueprintLicense | undefined {
  if (!terms) return undefined;
  return {
    id: terms.id,
    spdx: terms.spdx,
    commercial: terms.commercial,
    derivative: terms.derivative,
    runtimeExecution: terms.runtimeExecution,
    expiry: terms.expiry,
    seats: terms.seats,
    termsUri: terms.termsUri,
    hash: hashLicenseTerms(terms),
  };
}

function buildMintCapability(
  chain: X402ChainId,
  drop: DropRecord,
): BlueprintCapability {
  const payment = createPaymentRequirements({
    chain,
    amountAtomic: drop.price,
    resource: `drop:${drop.dropId}`,
    description: `JOY edition mint for drop ${drop.dropId}`,
  });
  return {
    id: "mint",
    name: "Mint edition",
    priceUsdc: atomicToUsdc(drop.price),
    priceAtomic: drop.price,
    requiresProof: drop.requiresProof,
    payment,
    invocation: {
      ipcChannel: "x402:purchase-edition",
      mcpTool: "purchase_execute",
      args: { chain, dropId: drop.dropId },
    },
  };
}

/**
 * Build a blueprint for a single EditionController drop (a purchasable
 * capability). This is the most common discovery target.
 */
export async function buildDropBlueprint(
  chain: X402ChainId,
  dropId: string,
  opts?: { license?: LicenseTerms },
): Promise<InterfaceBlueprint> {
  const drop = await getDropCached(chain, dropId);
  let store: (StoreRecord & { ensName?: string }) | undefined;
  let identity: BlueprintIdentity | undefined;
  let reputation: BlueprintReputation | undefined;

  if (drop.storeId !== "0") {
    try {
      const rec = await getStoreCached(chain, drop.storeId);
      const ensName = rec.slug ? storeName(rec.slug) : undefined;
      store = { ...rec, ensName };
      identity = await resolveIdentity(chain, rec.agentId, ensName);
      reputation = await resolveReputation(chain, rec.agentId);
    } catch (err) {
      logger.warn(`store lookup failed for drop ${dropId}: ${err}`);
    }
  }

  return {
    version: BLUEPRINT_VERSION,
    kind: "drop",
    chain,
    resourceId: dropId,
    identity,
    reputation,
    runtime: resolveRuntime(identity),
    license: resolveLicense(opts?.license),
    store,
    capabilities: [buildMintCapability(chain, drop)],
    contracts: {
      revenueSplitter: getRevenueSplitterAddress(chain),
      usdc: getUsdcAddress(chain),
    },
    ready: isGlueReady(chain) && isX402Ready(chain),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build a blueprint for a storefront, including its identity, reputation and
 * ENS name. Capabilities are left empty (enumerate drops separately).
 */
export async function buildStoreBlueprint(
  chain: X402ChainId,
  storeId: string,
): Promise<InterfaceBlueprint> {
  const rec = await getStoreCached(chain, storeId);
  const ensName = rec.slug ? storeName(rec.slug) : undefined;
  const identity = await resolveIdentity(chain, rec.agentId, ensName);
  const reputation = await resolveReputation(chain, rec.agentId);

  return {
    version: BLUEPRINT_VERSION,
    kind: "store",
    chain,
    resourceId: storeId,
    identity,
    reputation,
    runtime: resolveRuntime(identity),
    store: { ...rec, ensName },
    capabilities: [],
    contracts: {
      revenueSplitter: getRevenueSplitterAddress(chain),
      usdc: getUsdcAddress(chain),
    },
    ready: isGlueReady(chain) && isX402Ready(chain),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build a blueprint for an ERC-8004 agent (identity + reputation only).
 */
export async function buildAgentBlueprint(
  chain: X402ChainId,
  agentId: string,
): Promise<InterfaceBlueprint> {
  const identity = await resolveIdentity(chain, agentId);
  const reputation = await resolveReputation(chain, agentId);

  return {
    version: BLUEPRINT_VERSION,
    kind: "agent",
    chain,
    resourceId: agentId,
    identity,
    reputation,
    runtime: resolveRuntime(identity),
    capabilities: [],
    contracts: {
      revenueSplitter: getRevenueSplitterAddress(chain),
      usdc: getUsdcAddress(chain),
    },
    ready: isX402Ready(chain),
    generatedAt: new Date().toISOString(),
  };
}

/** The fully-qualified ENS asset name for a drop under a store (discovery aid). */
export function blueprintAssetName(assetSlug: string, storeSlug: string): string {
  return assetName(assetSlug, storeSlug);
}
