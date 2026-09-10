/**
 * MCP Tools — browsing Joy Marketplace.
 *
 * Reads the live Goldsky drop subgraph on Arbitrum Sepolia.
 *
 * These previously fetched `${JOYMARKETPLACE_API.baseUrl}/v1/assets`, a REST
 * surface that does not exist — `baseUrl` points at the Supabase Edge Functions
 * root, not a versioned API, so every call 404'd. The catalogue lives on-chain
 * and is indexed by the subgraph, which is what the marketplace's own UI and
 * its hosted MCP server both read.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getDrop,
  listDrops,
  listDropsByCreator,
} from "@/lib/joymarketplace/drop_subgraph";
import { runTool } from "./invoke_handler";

export function registerMarketplaceTools(server: McpServer) {
  // ── Browse ───────────────────────────────────────────────────────
  server.registerTool(
    "joycreate_marketplace_browse",
    {
      description:
        "Browse assets listed on Joy Marketplace, newest first. Reads the on-chain " +
        "catalogue via the drop subgraph. Returns token ids, prices (in the listed " +
        "currency's smallest unit), supply and the store each asset belongs to.",
      inputSchema: {
        pageSize: z.number().optional().describe("Results per page, 1-100 (default 20)"),
        page: z.number().optional().describe("1-based page number"),
        creator: z
          .string()
          .optional()
          .describe("Filter to one creator's assets by wallet address"),
      },
    },
    async ({ pageSize, page, creator }) =>
      runTool("joycreate_marketplace_browse", async () =>
        // Creator-scoped reads go through the store-scoped index, where each
        // token records the wallet that minted it.
        creator
          ? listDropsByCreator({ creator: creator.toLowerCase(), pageSize, page })
          : listDrops({ pageSize, page }),
      ),
  );

  // ── Asset detail ─────────────────────────────────────────────────
  server.registerTool(
    "joycreate_marketplace_asset_detail",
    {
      description:
        "Full detail for one Joy Marketplace asset: pricing, supply, claim conditions " +
        "and the store that published it. Accepts either a bare token id or the " +
        "contract-scoped form `<contract>-<tokenId>`, since per-store drops each " +
        "restart numbering at zero.",
      inputSchema: {
        assetId: z
          .string()
          .describe("Token id, or `<contract>-<tokenId>` for a per-store drop"),
      },
    },
    async ({ assetId }) =>
      runTool("joycreate_marketplace_asset_detail", async () => {
        const drop = await getDrop(assetId);
        if (!drop) {
          throw new Error(`No asset found for id ${assetId}`);
        }
        return drop;
      }),
  );
}
