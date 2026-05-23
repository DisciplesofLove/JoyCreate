import { createThirdwebClient, getContract, defineChain } from "thirdweb";

// Thirdweb client — uses env var or hardcoded fallback
const THIRDWEB_CLIENT_ID =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_THIRDWEB_CLIENT_ID) ||
  "bed83259c0fb5a34eb2a83e4f2446fa7";

export const thirdwebClient = createThirdwebClient({
  clientId: THIRDWEB_CLIENT_ID,
});

// Polygon Amoy Testnet
export const TARGET_CHAIN_ID = 80002;
export const TARGET_CHAIN_NAME = "Polygon Amoy Testnet";

export function getThirdwebChain(chainId?: number) {
  return defineChain(chainId ?? TARGET_CHAIN_ID);
}

// Deployed contracts
export const THIRDWEB_CONTRACTS = {
  nftCollection: {
    address: "0xb099296fe65a2185731aC8B1411A56175e6Be47a" as const,
    chainId: TARGET_CHAIN_ID,
    name: "JoyLicenseToken",
    standard: "ERC-1155" as const,
  },
  /** Alias — wizard references THIRDWEB_CONTRACTS.edition */
  edition: {
    address: "0xb099296fe65a2185731aC8B1411A56175e6Be47a" as const,
    chainId: TARGET_CHAIN_ID,
    name: "JoyLicenseToken",
    standard: "ERC-1155" as const,
  },
} as const;

// =============================================================================
// Goldsky Subgraph Endpoints (per-chain)
// =============================================================================

/**
 * Per-chain Goldsky subgraph endpoints. Must mirror the marketplace's
 * `joy-marketplace-80/src/config/endpoints.ts` so JoyCreate reads from the
 * same indexers the marketplace UI uses.
 *
 * The MarketplaceV3 subgraph (`joy-marketplace-amoy`) was retired in the
 * 2026-05-02 architecture pivot — all browse/detail/ownership queries hit
 * the DropERC1155 + Stores subgraphs only.
 *
 * Override defaults via env vars:
 *   VITE_DROP_SUBGRAPH_AMOY / _STORES_SUBGRAPH_AMOY
 *   VITE_DROP_SUBGRAPH_ARB_SEPOLIA / _STORES_SUBGRAPH_ARB_SEPOLIA
 *   VITE_DROP_SUBGRAPH_ARB_ONE / _STORES_SUBGRAPH_ARB_ONE
 */
const env = (typeof import.meta !== "undefined" ? import.meta.env : undefined) as
  | Record<string, string | undefined>
  | undefined;

export const GOLDSKY_SUBGRAPHS = {
  polygonAmoy: {
    drop:
      env?.VITE_DROP_SUBGRAPH_AMOY ??
      "https://api.goldsky.com/api/public/project_cmnkv2wbi14re01un3l5lb3rf/subgraphs/joy-drop-amoy/0.0.3/gn",
    stores:
      env?.VITE_STORES_SUBGRAPH_AMOY ??
      "https://api.goldsky.com/api/public/project_cmnkv2wbi14re01un3l5lb3rf/subgraphs/joy-stores-amoy/0.0.3/gn",
  },
  arbitrumSepolia: {
    drop:
      env?.VITE_DROP_SUBGRAPH_ARB_SEPOLIA ??
      "https://api.goldsky.com/api/public/project_cmnkv2wbi14re01un3l5lb3rf/subgraphs/joy-drop-arbitrum-sepolia/0.0.3/gn",
    stores:
      env?.VITE_STORES_SUBGRAPH_ARB_SEPOLIA ??
      "https://api.goldsky.com/api/public/project_cmnkv2wbi14re01un3l5lb3rf/subgraphs/joy-stores-arbitrum-sepolia/0.0.2/gn",
  },
  arbitrumOne: {
    drop: env?.VITE_DROP_SUBGRAPH_ARB_ONE ?? "",
    stores: env?.VITE_STORES_SUBGRAPH_ARB_ONE ?? "",
  },
} as const;

export type SubgraphChainId = keyof typeof GOLDSKY_SUBGRAPHS;
export type SubgraphKind = "drop" | "stores";

/**
 * Query a Goldsky subgraph with a GraphQL query.
 *
 * Backwards-compatible: legacy callers may pass `"drop" | "stores"` as the
 * first argument; these default to the Polygon Amoy endpoints. New code
 * SHOULD pass the active `MarketplaceChainId` first:
 *   `querySubgraph("arbitrumSepolia", "drop", query, vars)`
 */
export async function querySubgraph(
  chainOrKind: SubgraphChainId | SubgraphKind,
  kindOrQuery: SubgraphKind | string,
  queryOrVars?: string | Record<string, unknown>,
  maybeVars?: Record<string, unknown>,
): Promise<any> {
  let url: string;
  let query: string;
  let variables: Record<string, unknown> | undefined;

  if (chainOrKind === "drop" || chainOrKind === "stores") {
    // Legacy 2-arg form: (kind, query, variables?)
    url = GOLDSKY_SUBGRAPHS.polygonAmoy[chainOrKind];
    query = kindOrQuery as string;
    variables = queryOrVars as Record<string, unknown> | undefined;
  } else {
    // New 3-arg form: (chainId, kind, query, variables?)
    const chain = GOLDSKY_SUBGRAPHS[chainOrKind];
    if (!chain) throw new Error(`Unknown subgraph chain: ${chainOrKind}`);
    const kind = kindOrQuery as SubgraphKind;
    url = chain[kind];
    if (!url) throw new Error(`No ${kind} subgraph configured for ${chainOrKind}`);
    query = queryOrVars as string;
    variables = maybeVars;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Subgraph query failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Subgraph error: ${json.errors[0].message}`);
  return json.data;
}

// Get a typed Thirdweb contract handle for the JoyLicenseToken
export function getJoyLicenseContract() {
  return getContract({
    client: thirdwebClient,
    chain: getThirdwebChain(),
    address: THIRDWEB_CONTRACTS.nftCollection.address,
  });
}
