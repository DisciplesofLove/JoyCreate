/**
 * LR6 / G6 — subgraph-backed discovery reads with RPC fallback.
 *
 * Reads Store/Drop records from the unified JOY Marketplace subgraph
 * (see `subgraph/`) when its endpoint is configured, falling back to direct
 * RPC reads via `glue_client` on any miss or error. This keeps discovery fast
 * once the (manually deployed) subgraph is live without breaking when it is not.
 */

import log from "electron-log";

import { GOLDSKY_SUBGRAPHS, querySubgraph } from "@/config/subgraphs";
import {
  getDrop,
  getStore,
  type DropRecord,
  type StoreRecord,
} from "@/lib/onchain/glue_client";
import type { GlueChainId } from "@/config/glue";

const logger = log.scope("subgraph_discovery");

/** Whether the unified marketplace subgraph endpoint is configured for `chain`. */
export function hasMarketplaceSubgraph(chain: GlueChainId): boolean {
  const entry = GOLDSKY_SUBGRAPHS[chain as keyof typeof GOLDSKY_SUBGRAPHS];
  return Boolean(entry && "marketplace" in entry && entry.marketplace);
}

const STORE_QUERY = `query Store($id: ID!) {
  store(id: $id) { id owner agentId slug }
}`;

const DROP_QUERY = `query Drop($id: ID!) {
  drop(id: $id) {
    id creator assetLeaf price maxSupply minted active requiresProof
    store { id }
  }
}`;

/** Read a store via the subgraph, falling back to RPC on miss/error. */
export async function getStoreCached(
  chain: GlueChainId,
  storeId: string,
): Promise<StoreRecord> {
  if (hasMarketplaceSubgraph(chain)) {
    try {
      const data = await querySubgraph(chain as never, "marketplace", STORE_QUERY, {
        id: storeId,
      });
      const s = data?.store;
      if (s) {
        return {
          storeId: String(s.id),
          owner: String(s.owner),
          agentId: String(s.agentId),
          slug: String(s.slug ?? ""),
        };
      }
    } catch (err) {
      logger.warn(`subgraph store read failed (${storeId}), using RPC: ${err}`);
    }
  }
  return getStore(chain, storeId);
}

/** Read a drop via the subgraph, falling back to RPC on miss/error. */
export async function getDropCached(
  chain: GlueChainId,
  dropId: string,
): Promise<DropRecord> {
  if (hasMarketplaceSubgraph(chain)) {
    try {
      const data = await querySubgraph(chain as never, "marketplace", DROP_QUERY, {
        id: dropId,
      });
      const d = data?.drop;
      if (d) {
        return {
          dropId: String(d.id),
          creator: String(d.creator),
          storeId: String(d.store?.id ?? "0"),
          assetLeaf: String(d.assetLeaf),
          price: String(d.price),
          maxSupply: String(d.maxSupply),
          minted: String(d.minted),
          active: Boolean(d.active),
          requiresProof: Boolean(d.requiresProof),
        };
      }
    } catch (err) {
      logger.warn(`subgraph drop read failed (${dropId}), using RPC: ${err}`);
    }
  }
  return getDrop(chain, dropId);
}
