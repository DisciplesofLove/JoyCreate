/**
 * publishAndMonetize — the canonical "create → license to our store" path.
 *
 * Generalizes the dataset-only `monetizeDataset` into a single bridge usable by
 * every creator asset type (app / workflow / model / agent / dataset …):
 *
 *   1. publishAndForget(...)            -> IPFS pin + IPLD shard + ERC-1155 mint.
 *   2. resolveStoreBySlug / registerStore -> the creator's on-chain storefront.
 *   3. createDrop(EditionController)    -> the x402-purchasable edition drop,
 *                                          keyed by the content merkle root.
 *   4. buildDropBlueprint(...)          -> the ERC-1144 interface blueprint that
 *                                          bridges discovery (8004scan / ENS) to
 *                                          the x402 USDC payment rail.
 *
 * The EditionController + ERC-1144 broker + x402 rail live ONLY on the Arbitrum
 * chains. When the active marketplace chain is not glue-capable (e.g. Polygon
 * Amoy) the function still publishes/mints but skips the drop + blueprint.
 *
 * Like `publishAndForget`, this NEVER throws — every failure is captured into
 * `errors`. The marketplace publish and the on-chain drop are independent: an
 * asset can be minted even if the drop cannot be created (e.g. store registry
 * unavailable), in which case `dropId` is left undefined.
 */

import log from "electron-log";
import { ethers } from "ethers";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import { GLUE_RPC, isGlueReady, type GlueChainId } from "@/config/glue";
import { usdcToAtomic } from "@/config/x402";
import { createDrop, registerStore, resolveStoreBySlug } from "@/lib/onchain/glue_client";
import { ensureStoreIdentity } from "@/lib/onchain/agent_card";
import { buildDropBlueprint, type InterfaceBlueprint } from "@/lib/onchain/interface_broker";
import { normalizeLicense } from "@/lib/onchain/license";
import { settleRegistrationFee, type RegistrationFeeResult } from "@/lib/x402/registration_fee";
import { DEFAULT_MARKETPLACE_CHAIN } from "@/lib/onchain/chain_registry";
import { readSettings } from "@/main/settings";
import { publishAndForget, type PublishInput, type PublishOutcome } from "./publish_orchestrator";

const logger = log.scope("publish_and_monetize");

export interface PublishAndMonetizeInput {
  /** Forwarded verbatim to publishAndForget (pin + shard + mint). */
  publish: PublishInput;
  /**
   * Glue/x402 chain for the EditionController drop + ERC-1144 blueprint. When
   * omitted it is derived from the active marketplace chain (settings); a
   * non-Arbitrum active chain yields a publish-only outcome (no drop).
   */
  chain?: GlueChainId;
  /**
   * EditionController store slug the drop is created under. When omitted it
   * falls back to the configured `marketplaceStoreSlug` setting; an empty slug
   * yields a publish-only outcome (mint without a purchasable drop).
   */
  storeSlug?: string;
  /** Human-readable USDC price (e.g. 1.5). Drives both the mint and drop price. */
  priceUsdc: number;
  /** EIP-2981 royalty in basis points. Default 250 (2.5%). */
  royaltyBps?: number;
  /** Max editions; 0 = unlimited. Default 0. */
  maxSupply?: number;
  /** Require proof-of-use before mint. Default false. */
  requiresProof?: boolean;
  /**
   * 0x-prefixed 32-byte asset leaf committed by the drop. When omitted the
   * publish merkle root (or content hash) is used; non-hex sources are hashed.
   */
  assetLeafSource?: string | null;
  /** ERC-8004 agent id recorded when auto-registering a store. Default "0". */
  agentId?: string;
  /**
   * When true, charge the x402 store-registration fee (LR6 / G4) before
   * auto-registering a new store. On a fee-ready chain a failed payment aborts
   * the registration (no free store); on a chain without the fee configured the
   * registration proceeds and `registrationFee.charged` is false.
   */
  chargeRegistrationFee?: boolean;
  /** When true, pin/estimate only — no on-chain writes. */
  dryRun?: boolean;
}

export interface PublishAndMonetizeOutcome {
  ok: boolean;
  dryRun: boolean;
  /** Full publishAndForget outcome (tokenId, cids, merkleRoot, gas …). */
  publish: PublishOutcome;
  /** Glue chain the drop was created on, or null when not glue-capable. */
  chain: GlueChainId | null;
  /** EditionController store id (resolved or auto-registered). */
  storeId?: string;
  /** True when the store was auto-registered during this publish. */
  storeRegistered?: boolean;
  /** Store-registration fee outcome (LR6), present only when a store was registered. */
  registrationFee?: RegistrationFeeResult;
  /** ERC-8004 agent id bound to the store ("0" when no identity was minted). */
  agentId?: string;
  /** Agent-card IPFS CID minted with the identity (the runtime manifest). */
  agentCardCid?: string;
  /** EditionController drop id (the x402-purchasable edition). */
  dropId?: string;
  dropTxHash?: string;
  /** ERC-1144 interface blueprint for the drop (the discovery bridge). */
  blueprint?: InterfaceBlueprint;
  /** Public marketplace URL echoed from the publish outcome. */
  marketplaceUrl?: string;
  errors: string[];
}

/** Load the active secp256k1 chain key as an ethers.Wallet bound to the glue RPC. */
async function loadGlueWallet(chain: GlueChainId): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
  if (!active) {
    throw new Error("no active chain (secp256k1) key in jcnKeyManager — import one in Settings");
  }
  const pk = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!pk) throw new Error("active chain key has no private material");
  const provider = new ethers.JsonRpcProvider(GLUE_RPC[chain]);
  const hex = pk.toString("hex");
  return new ethers.Wallet(hex.startsWith("0x") ? hex : `0x${hex}`, provider);
}

/** Coerce an arbitrary source string into a 0x-prefixed 32-byte asset leaf. */
function toAssetLeaf(source: string | null | undefined, fallback: string): string {
  const candidate = source ?? fallback;
  if (/^0x[0-9a-fA-F]{64}$/.test(candidate)) return candidate;
  return ethers.keccak256(ethers.toUtf8Bytes(candidate));
}

/**
 * Resolve the glue/x402 chain. An explicit Arbitrum value wins; otherwise the
 * active marketplace chain is consulted. Returns null when the active chain is
 * not glue-capable (e.g. Polygon Amoy) so callers publish-only.
 */
function resolveGlueChain(explicit?: GlueChainId): GlueChainId | null {
  if (explicit === "arbitrumSepolia" || explicit === "arbitrumOne") return explicit;
  try {
    const settings = readSettings();
    const candidate =
      (settings as { marketplaceChain?: string }).marketplaceChain ?? DEFAULT_MARKETPLACE_CHAIN;
    if (candidate === "arbitrumSepolia" || candidate === "arbitrumOne") return candidate;
  } catch {
    // settings unavailable — fall through to publish-only.
  }
  return null;
}

/** Read the configured creator store slug ("our store") from settings. */
function readConfiguredStoreSlug(): string | undefined {
  try {
    const settings = readSettings();
    return (settings as { marketplaceStoreSlug?: string }).marketplaceStoreSlug;
  } catch {
    return undefined;
  }
}

/**
 * Publish an asset to the marketplace AND create an EditionController drop +
 * ERC-1144 blueprint so the listing is purchasable through the x402 rail.
 */
export async function publishAndMonetize(
  input: PublishAndMonetizeInput,
): Promise<PublishAndMonetizeOutcome> {
  const errors: string[] = [];
  const royaltyBps = input.royaltyBps ?? 250;

  // priceUsdc is human (e.g. 1.5); both the mint and the drop want USDC atomic
  // base units (6 decimals).
  const priceAtomic = usdcToAtomic(String(input.priceUsdc));
  const storeSlug = (
    input.publish.storeSlug ??
    input.storeSlug ??
    readConfiguredStoreSlug() ??
    ""
  ).trim();

  const publish = await publishAndForget({
    ...input.publish,
    priceUsdc: Number(priceAtomic),
    royaltyBps,
    storeSlug,
    dryRun: input.dryRun,
  });
  if (publish.errors?.length) errors.push(...publish.errors);

  const chain = resolveGlueChain(input.chain);

  let storeId: string | undefined;
  let storeRegistered = false;
  let registrationFee: RegistrationFeeResult | undefined;
  let agentId: string | undefined;
  let agentCardCid: string | undefined;
  let dropId: string | undefined;
  let dropTxHash: string | undefined;
  let blueprint: InterfaceBlueprint | undefined;

  // Create the on-chain drop only when the marketplace publish actually landed
  // on chain. A drop with no mint has nothing to point buyers at.
  if (publish.ok && !publish.dryRun && chain) {
    if (!isGlueReady(chain)) {
      // Active chain is Arbitrum but the glue stack is not deployed there.
      errors.push(`x402-drop: EditionController not deployed on ${chain}`);
    } else if (!storeSlug) {
      errors.push(
        "x402-drop: no store slug configured — set one in Settings → Joy Marketplace to create a purchasable drop",
      );
    } else {
      try {
        const wallet = await loadGlueWallet(chain);

        // Resolve — or auto-register — the creator's storefront.
        storeId = await resolveStoreBySlug(chain, storeSlug);
        if (!storeId || storeId === "0") {
          // Bind an ERC-8004 identity (+ pinned agent-card runtime manifest)
          // to the store. An explicit agentId wins; otherwise mint/reuse one.
          agentId = input.agentId && input.agentId !== "0" ? input.agentId : undefined;
          if (!agentId) {
            try {
              const identity = await ensureStoreIdentity(wallet, {
                chain,
                slug: storeSlug,
                type: "store",
              });
              agentId = identity.agentId;
              agentCardCid = identity.agentCardCid;
              logger.info(
                `store identity ${identity.agentId} (${identity.minted ? "minted" : "reused"})`,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              logger.warn(`identity mint failed, registering store without identity: ${message}`);
              errors.push(`identity: ${message}`);
            }
          }
          // LR6 / G4: charge the store-registration fee before registering.
          // A failed payment on a fee-ready chain aborts the registration so
          // the store is never created for free.
          if (input.chargeRegistrationFee) {
            registrationFee = await settleRegistrationFee(wallet, {
              chain,
              slug: storeSlug,
            });
          }
          const reg = await registerStore(wallet, {
            chain,
            slug: storeSlug,
            agentId: agentId ?? "0",
          });
          storeId = reg.storeId;
          storeRegistered = true;
          logger.info(`auto-registered store ${storeId} for slug "${storeSlug}"`);
        }

        const assetLeaf = toAssetLeaf(
          input.assetLeafSource ?? publish.merkleRoot ?? publish.contentHash,
          publish.contentCid ?? input.publish.name,
        );
        const drop = await createDrop(wallet, {
          chain,
          storeId,
          assetLeaf,
          price: priceAtomic.toString(),
          maxSupply: String(input.maxSupply ?? 0),
          requiresProof: input.requiresProof ?? false,
        });
        dropId = drop.dropId;
        dropTxHash = drop.txHash;
        logger.info(`created x402 drop ${dropId} for publish (token ${publish.tokenId})`);

        // The ERC-1144 blueprint bridges discovery to the x402 payment rail.
        try {
          const license = normalizeLicense(
            input.publish.licenseTerms ?? input.publish.license,
          );
          blueprint = await buildDropBlueprint(chain, dropId, { license });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("blueprint build failed:", message);
          errors.push(`blueprint: ${message}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("x402 drop creation failed:", message);
        errors.push(`x402-drop: ${message}`);
      }
    }
  }
  // chain === null (e.g. Polygon Amoy): publish-only, no drop expected.

  return {
    ok: publish.ok,
    dryRun: publish.dryRun,
    publish,
    chain: chain ?? null,
    storeId,
    storeRegistered,
    registrationFee,
    agentId,
    agentCardCid,
    dropId,
    dropTxHash,
    blueprint,
    marketplaceUrl: publish.marketplaceUrl,
    errors,
  };
}
