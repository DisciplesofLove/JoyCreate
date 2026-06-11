/**
 * LR6 / G6 — ENS ↔ StoreRegistry slug unification.
 *
 * One canonical store identity across both naming systems. The **canonical
 * direction is slug → name**: the StoreRegistry `slug` is the source of truth,
 * and the hierarchical ENS name is derived from it via `storeName(slug)`. A
 * store is "unified" when that derived name resolves on-chain to the same
 * controlling address as the store's ERC-8004 agent (or, if the store has no
 * agent, its owner).
 *
 * This module reads only — it does not write ENS records. Use it to verify a
 * store's identity is consistent before trusting an ENS name for discovery.
 */

import log from "electron-log";

import type { GlueChainId } from "@/config/glue";
import { getStore, makeProvider } from "@/lib/onchain/glue_client";
import { getAgent } from "@/lib/onchain/erc8004_client";
import { resolveAddress, storeName } from "@/lib/onchain/ens_hierarchical";
import type { Erc8004ChainId } from "@/config/erc8004";

const logger = log.scope("store_identity");

/**
 * The canonical hierarchical ENS name for a store slug. Slug → name is the
 * single source of truth; never derive the slug from an ENS name.
 */
export function canonicalStoreName(slug: string): string {
  return storeName(slug);
}

export interface StoreIdentityReconciliation {
  slug: string;
  /** Canonical ENS name derived from the slug. */
  ensName: string;
  /** On-chain store owner. */
  owner: string;
  /** ERC-8004 agent id bound to the store ("0" if none). */
  agentId: string;
  /** The address the store identity is expected to control (agent or owner). */
  expectedAddress: string;
  /** Address the ENS name currently resolves to (null if unresolved). */
  resolvedAddress: string | null;
  /** True when the ENS name resolves to the expected address. */
  unified: boolean;
  /** Why reconciliation did not match, when `unified` is false. */
  reason?: string;
}

/**
 * Reconcile a store's ENS name with its StoreRegistry slug + agent identity.
 * Resolves the canonical name and compares it to the agent address (preferred)
 * or the store owner. Resolution failures are non-fatal — they surface as
 * `unified: false` with a `reason`, so callers can decide whether to publish an
 * ENS record to close the gap.
 */
export async function reconcileStoreIdentity(
  chain: GlueChainId,
  storeId: string,
): Promise<StoreIdentityReconciliation> {
  const store = await getStore(chain, storeId);
  const ensName = canonicalStoreName(store.slug);

  // Prefer the ERC-8004 agent address as the canonical controller; fall back
  // to the store owner when the store has no bound agent.
  let expectedAddress = store.owner;
  if (store.agentId && store.agentId !== "0") {
    try {
      const agent = await getAgent(chain as Erc8004ChainId, store.agentId);
      if (agent.agentAddress) expectedAddress = agent.agentAddress;
    } catch (err) {
      logger.warn(`agent ${store.agentId} lookup failed during reconcile: ${err}`);
    }
  }

  let resolvedAddress: string | null = null;
  let reason: string | undefined;
  try {
    resolvedAddress = await resolveAddress(ensName, makeProvider(chain));
  } catch (err) {
    reason = `ENS resolution failed: ${err}`;
  }

  if (!resolvedAddress && !reason) {
    reason = `no address record for ${ensName}`;
  }
  const unified =
    resolvedAddress != null &&
    resolvedAddress.toLowerCase() === expectedAddress.toLowerCase();
  if (resolvedAddress && !unified && !reason) {
    reason = `${ensName} resolves to ${resolvedAddress}, expected ${expectedAddress}`;
  }

  return {
    slug: store.slug,
    ensName,
    owner: store.owner,
    agentId: store.agentId,
    expectedAddress,
    resolvedAddress,
    unified,
    reason: unified ? undefined : reason,
  };
}
