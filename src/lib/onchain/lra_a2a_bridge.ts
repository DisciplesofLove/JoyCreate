/**
 * LR13 — Identity ↔ A2A principal bridge.
 *
 * Mirrors an ERC-8004 on-chain agent (agentId + agentDomain/card + controller
 * address) into the local A2A economy: ensures the agent has an A2A principal
 * (DID + budget), reconciles the principal's payout wallet to the on-chain
 * controller, and publishes (or reuses) a service listing for the agent's
 * Licensed Runtime Asset under the `lra.runtime` capability.
 *
 * The on-chain binding (chain + erc8004AgentId + controller + skillCid) is
 * stored on the listing's `inputSchemaJson` under the namespaced
 * `x-lra-binding` key, so LR14's A2A executor can recover which ERC-8004 agent
 * to invoke without a schema migration.
 *
 * All A2A persistence is injected (`BridgeDeps`) so the orchestration is
 * unit-tested without the SQLite + SSI stack.
 */

import log from "electron-log";

import type { GlueChainId } from "@/config/glue";
import type { A2ACurrency, AgentServiceListingRow } from "@/db/a2a_schema";
import {
  getOrCreatePrincipal,
  updatePrincipalPayoutWallet,
  listListings,
  createListing,
  type CreateListingInput,
} from "@/lib/a2a_economy";

const logger = log.scope("lra_a2a_bridge");

/** Capability under which Licensed Runtime Assets are listed in the A2A market. */
export const LRA_RUNTIME_CAPABILITY = "lra.runtime";

/** Namespaced key on a listing's `inputSchemaJson` that carries the on-chain binding. */
export const LRA_BINDING_KEY = "x-lra-binding";

export interface LraBinding {
  erc8004AgentId: string;
  chain: GlueChainId;
  agentAddress: string;
  skillCid?: string;
}

export interface BridgeInput {
  /** Local `agents.id` the principal is anchored to. */
  localAgentId: number;
  /** On-chain ERC-8004 agentId being mirrored. */
  erc8004AgentId: string;
  chain: GlueChainId;
  /** On-chain controller address → mirrored into the principal's payout wallet. */
  agentAddress: string;
  /** Resolved skill bundle CID, when known. */
  skillCid?: string;
  listingName?: string;
  description?: string;
  pricing?: {
    pricingModel?: CreateListingInput["pricingModel"];
    priceAmount?: string;
    currency?: A2ACurrency;
  };
}

export interface BridgeResult {
  principalId: string;
  did: string;
  listingId: string;
  capability: string;
  binding: LraBinding;
  /** True when a new listing was created; false when an existing one was reused. */
  createdListing: boolean;
}

export interface BridgeDeps {
  getOrCreatePrincipal?: typeof getOrCreatePrincipal;
  updatePrincipalPayoutWallet?: typeof updatePrincipalPayoutWallet;
  listListings?: typeof listListings;
  createListing?: typeof createListing;
}

/** Read the LRA binding off a listing, or null if it carries none. */
export function readListingBinding(listing: AgentServiceListingRow): LraBinding | null {
  const schema = listing.inputSchemaJson as Record<string, unknown> | null;
  const raw = schema?.[LRA_BINDING_KEY];
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.erc8004AgentId !== "string" || typeof b.chain !== "string") return null;
  if (typeof b.agentAddress !== "string") return null;
  return {
    erc8004AgentId: b.erc8004AgentId,
    chain: b.chain as GlueChainId,
    agentAddress: b.agentAddress,
    skillCid: typeof b.skillCid === "string" ? b.skillCid : undefined,
  };
}

/**
 * Bridge an ERC-8004 agent into the A2A economy. Idempotent: reuses an existing
 * `lra.runtime` listing bound to the same on-chain agentId on the same chain.
 */
export async function bridgeIdentityToA2a(
  input: BridgeInput,
  deps: BridgeDeps = {},
): Promise<BridgeResult> {
  if (!Number.isInteger(input.localAgentId) || input.localAgentId <= 0) {
    throw new Error("localAgentId must be a positive integer");
  }
  if (!input.erc8004AgentId?.trim()) throw new Error("erc8004AgentId is required");
  if (!input.agentAddress?.trim()) throw new Error("agentAddress is required");

  const ensurePrincipal = deps.getOrCreatePrincipal ?? getOrCreatePrincipal;
  const reconcilePayout = deps.updatePrincipalPayoutWallet ?? updatePrincipalPayoutWallet;
  const queryListings = deps.listListings ?? listListings;
  const addListing = deps.createListing ?? createListing;

  // 1. Ensure the agent has an A2A principal (DID), seeding the payout wallet.
  const principal = await ensurePrincipal(input.localAgentId, {
    payoutWallet: input.agentAddress,
  });

  // 2. Reconcile the payout wallet ↔ on-chain controller for existing principals.
  if (principal.payoutWallet !== input.agentAddress) {
    await reconcilePayout(principal.id, input.agentAddress);
  }

  const binding: LraBinding = {
    erc8004AgentId: input.erc8004AgentId,
    chain: input.chain,
    agentAddress: input.agentAddress,
    skillCid: input.skillCid,
  };

  // 3. Reuse an existing lra.runtime listing bound to the same on-chain agent.
  const existing = await queryListings({
    principalId: principal.id,
    capability: LRA_RUNTIME_CAPABILITY,
  });
  const match = existing.find((l) => {
    const b = readListingBinding(l);
    return b?.erc8004AgentId === input.erc8004AgentId && b?.chain === input.chain;
  });
  if (match) {
    logger.info(
      `reused A2A listing ${match.id} for ERC-8004 agent ${input.erc8004AgentId} (${input.chain})`,
    );
    return {
      principalId: principal.id,
      did: principal.did,
      listingId: match.id,
      capability: LRA_RUNTIME_CAPABILITY,
      binding,
      createdListing: false,
    };
  }

  // 4. Otherwise publish a fresh listing carrying the on-chain binding.
  const listing = await addListing({
    principalId: principal.id,
    name: input.listingName ?? `Runtime: ERC-8004 agent ${input.erc8004AgentId}`,
    description:
      input.description ??
      `Licensed Runtime Asset for ERC-8004 agent ${input.erc8004AgentId} on ${input.chain}.`,
    capability: LRA_RUNTIME_CAPABILITY,
    tags: ["lra", "erc8004", input.chain],
    pricingModel: input.pricing?.pricingModel ?? "per_call",
    priceAmount: input.pricing?.priceAmount ?? "0",
    currency: input.pricing?.currency ?? "USDC",
    inputSchemaJson: {
      type: "object",
      properties: { input: { type: "string", description: "User input for the runtime skill." } },
      required: ["input"],
      [LRA_BINDING_KEY]: binding,
    },
  });

  logger.info(
    `bridged ERC-8004 agent ${input.erc8004AgentId} (${input.chain}) → principal ` +
      `${principal.id} / listing ${listing.id}`,
  );
  return {
    principalId: principal.id,
    did: principal.did,
    listingId: listing.id,
    capability: LRA_RUNTIME_CAPABILITY,
    binding,
    createdListing: true,
  };
}
