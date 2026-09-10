import { createThirdwebClient, getContract, defineChain } from "thirdweb";

// Thirdweb client — uses env var or hardcoded fallback
const THIRDWEB_CLIENT_ID =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_THIRDWEB_CLIENT_ID) ||
  "bed83259c0fb5a34eb2a83e4f2446fa7";

export const thirdwebClient = createThirdwebClient({
  clientId: THIRDWEB_CLIENT_ID,
});

// Arbitrum Sepolia — the only chain this app transacts on. Was Polygon Amoy
// (80002); the marketplace moved and its Amoy subgraphs were decommissioned.
export const TARGET_CHAIN_ID = 421614;
export const TARGET_CHAIN_NAME = "Arbitrum Sepolia";

export function getThirdwebChain(chainId?: number) {
  return defineChain(chainId ?? TARGET_CHAIN_ID);
}

/**
 * Deployed contracts — Arbitrum Sepolia.
 *
 * `JoyLicenseToken` (0xb099296f… on Polygon Amoy) is gone with that chain. The
 * shared-collection model went with it: the marketplace now mints into a
 * per-store DropERC1155 clone resolved from the store's ENS label, so there is
 * no single "nftCollection" address to hand out. `platformDrop` below is the
 * shared drop the subgraph still indexes for pre-per-store assets; new mints
 * should go through `resolveStoreDrop()` in
 * `src/lib/joymarketplace/store_drop_publisher.ts`.
 */
export const THIRDWEB_CONTRACTS = {
  nftCollection: {
    address: "0x61672aa9c97342183481455834e6e944ea64e552" as const,
    chainId: TARGET_CHAIN_ID,
    name: "JoyPlatformDrop",
    standard: "ERC-1155" as const,
  },
  /** Alias — the legacy CreateAssetWizard references `.edition`. */
  edition: {
    address: "0x61672aa9c97342183481455834e6e944ea64e552" as const,
    chainId: TARGET_CHAIN_ID,
    name: "JoyPlatformDrop",
    standard: "ERC-1155" as const,
  },
} as const;

// =============================================================================
// Goldsky Subgraph Endpoints — re-exported from ./subgraphs
// =============================================================================
//
// GOLDSKY_SUBGRAPHS + querySubgraph live in `./subgraphs` (SDK-free) so the
// Electron main bundle can use them without pulling thirdweb v5 into the
// main process. Renderer code can keep importing them from here for back-compat.
export { GOLDSKY_SUBGRAPHS, querySubgraph } from "./subgraphs";
export type { SubgraphChainId, SubgraphKind } from "./subgraphs";

// Get a typed Thirdweb contract handle for the JoyLicenseToken
export function getJoyLicenseContract() {
  return getContract({
    client: thirdwebClient,
    chain: getThirdwebChain(),
    address: THIRDWEB_CONTRACTS.nftCollection.address,
  });
}
