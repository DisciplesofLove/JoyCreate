/**
 * MCP Tools — Web 4.0 Marketplace Pipeline (ERC-8004 / ERC-1144 / X402)
 *
 * Exposes the full glue pipeline as four high-level, natural-language-mapped
 * tools so external AI agents can operate a store end to end:
 *
 *   store_register   → register an ENS-named store (StoreRegistry + ERC-8004 id)
 *   drop_launch      → create a priced ERC-1155 drop under a store (EditionController)
 *   discover         → fetch the ERC-1144 interface blueprint for a drop/store/agent
 *   purchase_execute → pay-per-mint a drop via the X402 USDC rail (spends real funds)
 *
 * These map directly onto already-registered IPC handlers:
 *   glue:register-store, glue:create-drop, broker:*-blueprint, x402:purchase-edition
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ipcMain } from "electron";

// Helper to invoke existing IPC handlers from MCP context.
async function invokeHandler(channel: string, ...args: unknown[]): Promise<any> {
  const handler = (ipcMain as any)._invokeHandlers?.get(channel);
  if (handler) {
    return handler({ sender: { id: -1 } }, ...args);
  }
  throw new Error(
    `IPC handler not found: ${channel}. Ensure handlers are registered before MCP server starts.`,
  );
}

const CHAIN_DESC =
  "Target chain key: 'arbitrumSepolia' (default) or 'arbitrumOne'.";

export function registerWeb4MarketplaceTools(server: McpServer) {
  // ── store_register ───────────────────────────────────────────────
  server.registerTool(
    "store_register",
    {
      description:
        "Register a new ENS-named storefront on the StoreRegistry. The store is bound to an " +
        "ERC-8004 agent identity and addressable as <slug>.store.<marketplace>.eth. " +
        "Returns the new storeId. Uses the local signing wallet (gas-only).",
      inputSchema: {
        slug: z
          .string()
          .describe("Store slug / ENS label, e.g. 'acme-models'. Must be unique."),
        agentId: z
          .string()
          .optional()
          .describe("ERC-8004 agent id to bind as the store operator (default '0' = owner)."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const result = await invokeHandler("glue:register-store", {
          chain: params.chain,
          slug: params.slug,
          agentId: params.agentId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error registering store: ${err.message}` }],
        };
      }
    },
  );

  // ── drop_launch ──────────────────────────────────────────────────
  server.registerTool(
    "drop_launch",
    {
      description:
        "Launch a priced ERC-1155 drop under a store via the EditionController. The drop is keyed " +
        "by an asset leaf (IPLD Merkle root of the content shard) and priced in USDC atomic units " +
        "(6 decimals; e.g. '1000000' = 1 USDC). Returns the new dropId. Uses the local signing wallet.",
      inputSchema: {
        storeId: z.string().describe("The storeId returned by store_register."),
        assetLeaf: z
          .string()
          .describe("Asset leaf — the IPLD/Merkle root hash (0x-prefixed) of the content shard."),
        price: z
          .string()
          .optional()
          .describe("Price in USDC atomic units (6 decimals). '0' = free. Default '0'."),
        maxSupply: z
          .string()
          .optional()
          .describe("Maximum editions mintable. '0' = unlimited. Default '0'."),
        requiresProof: z
          .boolean()
          .optional()
          .describe("If true, buyers need a proof grant before minting (PoU gate)."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const result = await invokeHandler("glue:create-drop", {
          chain: params.chain,
          storeId: params.storeId,
          assetLeaf: params.assetLeaf,
          price: params.price,
          maxSupply: params.maxSupply,
          requiresProof: params.requiresProof,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error launching drop: ${err.message}` }],
        };
      }
    },
  );

  // ── discover ─────────────────────────────────────────────────────
  server.registerTool(
    "discover",
    {
      description:
        "Discover a marketplace resource as an ERC-1144 interface blueprint. Returns identity " +
        "(ERC-8004 + ENS), reputation, store metadata, capabilities (including the X402 payment " +
        "requirements and the invocation contract to mint), and contract addresses. " +
        "Use this before purchase_execute to learn the price, payTo address, and asset.",
      inputSchema: {
        kind: z
          .enum(["drop", "store", "agent"])
          .describe("What to discover: a 'drop', a 'store', or an 'agent'."),
        id: z
          .string()
          .describe("The dropId, storeId, or agentId to inspect (matching 'kind')."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        let result: unknown;
        if (params.kind === "drop") {
          result = await invokeHandler("broker:drop-blueprint", {
            chain: params.chain,
            dropId: params.id,
          });
        } else if (params.kind === "store") {
          result = await invokeHandler("broker:store-blueprint", {
            chain: params.chain,
            storeId: params.id,
          });
        } else {
          result = await invokeHandler("broker:agent-blueprint", {
            chain: params.chain,
            agentId: params.id,
          });
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error discovering ${params.kind}: ${err.message}` }],
        };
      }
    },
  );

  // ── purchase_execute ─────────────────────────────────────────────
  server.registerTool(
    "purchase_execute",
    {
      description:
        "Execute an end-to-end pay-per-mint purchase of a drop over the X402 USDC rail. " +
        "This SPENDS REAL FUNDS: it signs an EIP-3009 USDC authorization, settles the payment " +
        "through the RevenueSplitter (80/10/10), grants proof if required, then mints the edition " +
        "via the EditionController. Returns the minted tokenId, payment receipt, and tx hashes. " +
        "Call discover first to confirm the price. Uses the local signing wallet — only invoke " +
        "with explicit user approval.",
      inputSchema: {
        dropId: z.string().describe("The dropId to purchase (from discover / drop_launch)."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const result = await invokeHandler("x402:purchase-edition", {
          chain: params.chain,
          dropId: params.dropId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error executing purchase: ${err.message}` }],
        };
      }
    },
  );
}
