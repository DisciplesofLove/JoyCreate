/**
 * MCP Tools — publishing to Joy Marketplace.
 *
 * This is the tool an external agent uses to put an asset on the marketplace.
 * It wraps the canonical pipeline (`joybridge:publish-asset` →
 * `publishAndForget` → `publishToMarketplace`), so it inherits every guarantee
 * that path provides:
 *
 *   - the asset is encrypted (AES-256-GCM, key wrapped by Lit) before any byte
 *     leaves the machine
 *   - chunks, envelope and metadata are pinned through the marketplace's own
 *     `ipfs-upload`, so CIDs match a CLI publish byte for byte
 *   - metadata lands in a tokenId-named directory, because `uri(N)` is
 *     `baseURI + N` and `_batchURI` is write-once with no setter
 *   - `nextTokenIdToMint` is re-read immediately before minting and the publish
 *     aborts on drift
 *
 * Deliberately NOT exposed here: anything that would let an agent publish
 * without those steps. There is one publish path and this is it.
 *
 * `joycreate_publish_dry_run` exists so an agent can prove the store resolves
 * and see which token id it would take, without spending gas or pinning
 * anything. Agents should call it before `joycreate_publish_asset`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ipcMain } from "electron";

async function invokeHandler(channel: string, ...args: unknown[]): Promise<any> {
  const handler = (ipcMain as any)._invokeHandlers?.get(channel);
  if (handler) {
    return handler({ sender: { id: -1 } }, ...args);
  }
  throw new Error(
    `IPC handler not found: ${channel}. Ensure handlers are registered before MCP server starts.`,
  );
}

/** Errors become MCP errors, not success payloads containing the word "error". */
function fail(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

const STORE_DESC =
  "Store ENS label, e.g. 'acme-models' for acme-models.joymarketplace.io. The " +
  "drop contract is derived from it, and the signing wallet must own the name " +
  "— lazyMint is onlyStoreOwner.";

export function registerPublishTools(server: McpServer) {
  // ── joycreate_publish_dry_run ────────────────────────────────────
  server.registerTool(
    "joycreate_publish_dry_run",
    {
      description:
        "Check that a store is publishable and report the token id the next publish " +
        "would take. Spends no gas, pins nothing, encrypts nothing. Call this before " +
        "joycreate_publish_asset to confirm the store resolves and the signing wallet " +
        "can reach it.",
      inputSchema: {
        store: z.string().describe(STORE_DESC),
      },
    },
    async ({ store }) => {
      try {
        // Deliberately NOT the publish path. `publishAndForget` loads a signer
        // as its first step, so routing a dry run through it failed with
        // "no signer configured" before it ever looked at the store — useless
        // precisely when you want it, i.e. before a wallet is set up.
        // Resolving the drop and reading the next token id are plain RPC reads.
        return ok(await invokeHandler("joybridge:check-store", { storeSlug: store }));
      } catch (err: any) {
        return fail(`Dry run failed: ${err?.message ?? String(err)}`);
      }
    },
  );

  // ── joycreate_publish_asset ──────────────────────────────────────
  server.registerTool(
    "joycreate_publish_asset",
    {
      description:
        "Publish an asset to Joy Marketplace: encrypt and chunk it, pin the chunks, " +
        "envelope and metadata to IPFS, then lazy-mint it on the store's drop contract " +
        "with the price installed as a claim condition. " +
        "SPENDS GAS on Arbitrum Sepolia and produces an immutable on-chain token — " +
        "only invoke with explicit user approval. The content is encrypted before it " +
        "leaves the machine; only a buyer holding the licence token can decrypt it. " +
        "Call joycreate_publish_dry_run first to confirm the store resolves.",
      inputSchema: {
        store: z.string().describe(STORE_DESC),
        name: z.string().describe("Listing title."),
        contentBase64: z
          .string()
          .optional()
          .describe(
            "The asset bytes, base64. This is what gets encrypted — never a URL or a " +
              "CID. Required unless dryRun is true: a dry run resolves the store and " +
              "reads the next token id without encrypting or pinning anything, so " +
              "sending the payload would cost time and memory to learn nothing extra.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Validate this exact request without spending gas or pinning: checks the " +
              "store resolves, a signer exists, and reports the token id the publish " +
              "would take. Cheap, and the only way to discover a missing wallet key " +
              "before the irreversible half begins.",
          ),
        contentFileName: z
          .string()
          .optional()
          .describe("Original filename, recorded in the envelope and metadata."),
        contentMimeType: z
          .string()
          .optional()
          .describe("MIME type of the content. Default application/octet-stream."),
        description: z.string().optional().describe("Listing description."),
        assetType: z
          .string()
          .optional()
          .describe("Category: model, dataset, agent, prompt, workflow, image, video."),
        priceUsdc: z
          .number()
          .optional()
          .describe(
            "Price in USDC base units (6 decimals): 1000000 = 1 USDC. 0 = free. Default 0.",
          ),
        royaltyBps: z
          .number()
          .optional()
          .describe("Creator royalty in basis points. Default 250 (2.5%)."),
        license: z.string().optional().describe("Licence label. Default 'commercial'."),
        coverImageBase64: z
          .string()
          .optional()
          .describe(
            "Cover art, base64. Without one the listing shows a placeholder — the asset " +
              "itself is encrypted and can never be the thumbnail.",
          ),
        coverImageMimeType: z.string().optional().describe("Cover MIME type."),
        coverImageCid: z
          .string()
          .optional()
          .describe("Pre-pinned cover CID, if you already pinned one."),
        attributes: z
          .array(z.object({ trait_type: z.string(), value: z.string() }))
          .optional()
          .describe("Extra listing traits, shown on the asset page and used by filters."),
      },
    },
    async (params) => {
      try {
        // A real publish with no content would encrypt nothing, pin nothing, and
        // still mint a token whose metadata points at an asset that does not
        // exist — an on-chain artefact that cannot be un-minted. Caught here
        // rather than deep in the pipeline so the message names the fix.
        if (!params.dryRun && !params.contentBase64) {
          return fail(
            "contentBase64 is required for a real publish. Pass dryRun: true to " +
              "validate the store and signer without it.",
          );
        }

        const res = await invokeHandler("joybridge:publish-asset", {
          dryRun: params.dryRun === true,
          storeId: params.store,
          name: params.name,
          description: params.description,
          assetType: params.assetType ?? "model",
          contentBase64: params.contentBase64,
          contentMimeType: params.contentMimeType,
          coverImageBase64: params.coverImageBase64,
          coverImageMimeType: params.coverImageMimeType,
          coverImageFileName: params.contentFileName
            ? `cover-${params.contentFileName}`
            : undefined,
          coverImageCid: params.coverImageCid,
          extraAttributes: params.attributes,
          priceUsdc: params.priceUsdc ?? 0,
          royaltyBps: params.royaltyBps,
          license: params.license,
          properties: {
            storeSlug: params.store,
            fileName: params.contentFileName,
          },
        });

        if (!res?.ok) {
          return fail(res?.error ?? "Publish failed");
        }

        const out = res.outcome ?? {};

        // A dry run must not report `published: true`. An agent reading that
        // would believe an on-chain token exists and move on to selling it.
        if (params.dryRun) {
          return ok({
            published: false,
            dryRun: true,
            wouldMintTokenId: out.tokenId,
            store: out.storeLabel,
            dropAddress: out.dropAddress,
            note:
              "Nothing was encrypted, pinned or minted. Re-send with contentBase64 " +
              "and no dryRun to publish for real.",
          });
        }

        return ok({
          published: true,
          tokenId: out.tokenId,
          store: out.storeLabel,
          dropAddress: out.dropAddress,
          metadataUri: out.metadataUri,
          decryptionEnvelopeCid: out.envelopeCid,
          merkleRoot: out.merkleRoot,
          chunkCount: out.chunkCount,
          mintTxHash: out.mintTxHash,
          claimConditionTxHash: out.listTxHash,
          marketplaceUrl: out.marketplaceUrl,
          // Non-fatal problems the pipeline reports rather than throwing —
          // notably a uri() that does not resolve yet, which cannot be repaired
          // on-chain and so must never be swallowed.
          warnings: out.errors ?? [],
        });
      } catch (err: any) {
        return fail(`Publish failed: ${err?.message ?? String(err)}`);
      }
    },
  );
}
