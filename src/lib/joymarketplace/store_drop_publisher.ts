/**
 * Per-store DropERC1155 mint path — the contract surface the Joy Marketplace
 * actually indexes.
 *
 * Replaces the shared-platformDrop / EditionController route, which has never
 * carried a real asset: the live drop subgraph reports zero tokens on
 * `platformDrop`, while all indexed tokens sit on store clones spawned by
 * `JoyStoreDropFactory`.
 *
 * Mirrors `mfe-agents-quest/scripts/publish-asset.mjs` steps [2] and [5],
 * translated from viem to the ethers v6 this codebase uses.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  ARB_SEPOLIA_STORE_DROP_CONTRACTS,
  STORE_DROP_ABI,
  STORE_DROP_FACTORY_ABI,
} from "@/config/joymarketplace";

const logger = log.scope("store_drop_publisher");

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const UINT256_MAX = (1n << 256n) - 1n;

/** ENS label hash — keccak256 over the raw label bytes, matching viem's `labelhash`. */
export function labelHash(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

/**
 * Resolve a store's drop contract and confirm it is actually deployed.
 *
 * `predictStoreDrop` is deterministic and answers for stores that do not exist
 * yet, so the bytecode check is what distinguishes "this store has a drop" from
 * "this address is where its drop would go".
 */
export async function resolveStoreDrop(
  provider: ethers.Provider,
  storeLabel: string,
): Promise<string> {
  const factory = new ethers.Contract(
    ARB_SEPOLIA_STORE_DROP_CONTRACTS.storeDropFactory,
    STORE_DROP_FACTORY_ABI,
    provider,
  );
  const drop: string = await factory.predictStoreDrop(labelHash(storeLabel));

  const code = await provider.getCode(drop);
  if (!code || code === "0x") {
    throw new Error(
      `no drop contract deployed at ${drop} for store "${storeLabel}" — ` +
        `create the store first (marketplace repo: scripts/create-store.mjs)`,
    );
  }
  logger.info(`store "${storeLabel}" -> drop ${drop}`);
  return drop;
}

export function storeDropContract(
  address: string,
  runner: ethers.Provider | ethers.Signer,
): ethers.Contract {
  return new ethers.Contract(address, STORE_DROP_ABI, runner);
}

/** Current `nextTokenIdToMint` on a store drop. */
export async function readNextTokenId(
  provider: ethers.Provider,
  dropAddress: string,
): Promise<bigint> {
  return (await storeDropContract(dropAddress, provider).nextTokenIdToMint()) as bigint;
}

export interface MintResult {
  tokenId: string;
  lazyMintTxHash: string;
  setClaimTxHash: string;
}

/**
 * `lazyMint` one edition at `metadataUri`, then install its claim condition.
 *
 * `expectedTokenId` is re-read immediately before minting and the call aborts
 * on drift. That guard is not optional: encrypt-and-pin takes minutes, and a
 * competing publish to the same store moves `nextTokenIdToMint`. Minting anyway
 * would append at the new id while the metadata directory is named for the old
 * one, producing a token whose `uri()` 404s forever — `_batchURI` is write-once
 * in `lazyMint` with no setter. The wrapped AES key's access conditions embed
 * the tokenId too, so re-pinning metadata alone could not repair it.
 */
export async function mintEdition(
  wallet: ethers.Wallet,
  input: {
    dropAddress: string;
    metadataUri: string;
    expectedTokenId: bigint;
    /** USDC base units (6 decimals). 0 = free. */
    priceUsdc: bigint;
    maxSupply?: bigint;
    quantityLimitPerWallet?: bigint;
  },
): Promise<MintResult> {
  const provider = wallet.provider;
  if (!provider) throw new Error("wallet has no provider");

  const tokenIdNow = await readNextTokenId(provider, input.dropAddress);
  if (tokenIdNow !== input.expectedTokenId) {
    throw new Error(
      `token id moved from ${input.expectedTokenId} to ${tokenIdNow} while this ` +
        `asset was uploading — another publish to this store landed first. ` +
        `Nothing was minted; re-run to publish at #${tokenIdNow}.`,
    );
  }

  const drop = storeDropContract(input.dropAddress, wallet);

  const lazyMintTx = await drop.lazyMint(1n, input.metadataUri, "0x");
  const lazyMintReceipt = await lazyMintTx.wait();
  if (lazyMintReceipt?.status !== 1) {
    throw new Error("lazyMint reverted");
  }
  logger.info(`lazyMint ok: token #${input.expectedTokenId} tx ${lazyMintTx.hash}`);

  const claimCondition = {
    startTimestamp: 0n,
    maxClaimableSupply: input.maxSupply ?? UINT256_MAX,
    supplyClaimed: 0n,
    quantityLimitPerWallet: input.quantityLimitPerWallet ?? UINT256_MAX,
    merkleRoot: ZERO_BYTES32,
    pricePerToken: input.priceUsdc,
    currency: ARB_SEPOLIA_STORE_DROP_CONTRACTS.usdc,
    metadata: "",
  };

  const setClaimTx = await drop.setClaimConditions(
    input.expectedTokenId,
    [claimCondition],
    false,
  );
  const claimReceipt = await setClaimTx.wait();
  if (claimReceipt?.status !== 1) {
    throw new Error(
      `token #${input.expectedTokenId} was minted but setClaimConditions failed — ` +
        `it will not appear in the marketplace`,
    );
  }
  logger.info(`setClaimConditions ok: tx ${setClaimTx.hash}`);

  return {
    tokenId: input.expectedTokenId.toString(),
    lazyMintTxHash: lazyMintTx.hash,
    setClaimTxHash: setClaimTx.hash,
  };
}

/**
 * Read `uri(tokenId)` back and confirm it actually resolves.
 *
 * Advisory, never fatal: by the time this runs the token is minted and listed,
 * so throwing would wrongly imply nothing happened. It catches the failure
 * modes the pre-mint guard cannot — a directory missing its file, a pin that
 * never propagated, a malformed baseURI — while they are still cheap to learn
 * about.
 */
export async function verifyTokenUri(
  provider: ethers.Provider,
  dropAddress: string,
  tokenId: string,
  gatewayUrl: (uri: string) => string,
): Promise<{ ok: boolean; uri?: string; detail?: string }> {
  try {
    const uri: string = await storeDropContract(dropAddress, provider).uri(tokenId);
    const res = await fetch(gatewayUrl(String(uri)));
    if (!res.ok) {
      return {
        ok: false,
        uri: String(uri),
        detail:
          `uri(${tokenId}) returned HTTP ${res.status}. The token is minted and ` +
          `listed, but buyers cannot read its metadata. This CANNOT be repaired ` +
          `on-chain — _batchURI is write-once in lazyMint with no setter. ` +
          `Delist with setClaimConditions(maxClaimableSupply: 0) and re-mint.`,
      };
    }
    return { ok: true, uri: String(uri) };
  } catch (err) {
    return { ok: false, detail: `could not verify uri(${tokenId}): ${(err as Error).message}` };
  }
}
