/**
 * Joy Marketplace Subgraph Client
 *
 * Queries Goldsky-indexed subgraphs for on-chain marketplace data on
 * Arbitrum Sepolia — the only chain this app talks to:
 * - joy-store-drops-arbitrum-sepolia: tokens, purchases, user balances
 * - joy-stores-arbitrum-sepolia: stores, domains, agents, text records
 *
 * The MarketplaceV3 helpers below are retained as explicit failures rather than
 * deleted, so callers still compile and get a message naming the cause instead
 * of a silent empty list. See `marketplaceV3Retired`.
 */

import log from "electron-log";
import type {
  SubgraphToken,
  SubgraphPurchase,
  SubgraphUserBalance,
  SubgraphDropStats,
  SubgraphStore,
  SubgraphDomainRegistration,
  SubgraphStoreStats,
  MyMarketplaceAssets,
  SubgraphQueryParams,
  SubgraphTokensParams,
  SubgraphAsset,
  SubgraphListing,
  SubgraphAIModel,
  SubgraphAIModelLicense,
  SubgraphMarketplaceStats,
  SubgraphReceipt,
  SubgraphAssetsParams,
  SubgraphListingsParams,
  SubgraphAIModelsParams,
} from "@/types/subgraph_types";

const logger = log.scope("subgraph");

// ── Subgraph endpoints ─────────────────────────────────────────────────────

// Arbitrum Sepolia only. The three Polygon Amoy endpoints this module used to
// point at (`joy-drop-amoy@0.0.1`, `joy-stores-amoy@0.0.3`,
// `joy-marketplace-amoy@0.0.3`) were decommissioned — every one returned
// HTTP 404 "Subgraph not found", so `agent-market:*` and every other consumer
// here had been failing silently against a chain the marketplace had left.
const SUBGRAPH_URLS = {
  /** Per-store DropERC1155 clones + the legacy shared platform drop. */
  drops:
    "https://api.goldsky.com/api/public/project_cmnkv2wbi14re01un3l5lb3rf/subgraphs/joy-store-drops-arbitrum-sepolia/0.0.2/gn",
  stores:
    "https://api.goldsky.com/api/public/project_cmnkv2wbi14re01un3l5lb3rf/subgraphs/joy-stores-arbitrum-sepolia/0.0.5/gn",
} as const;

/**
 * The MarketplaceV3 lane is gone, not merely moved.
 *
 * `assets`, `listings`, `aimodels`, `licenses` and `receipts` were entities of
 * the retired `joy-marketplace-amoy` subgraph. Nothing on Arbitrum Sepolia
 * indexes them — the live drop subgraph exposes only `tokens`, `purchases`,
 * `userBalances`, `dropStats` and `storeDrops`.
 *
 * Throwing beats returning `[]`: an empty array reads as "no results" and the
 * caller renders an empty marketplace, which is exactly how this went unnoticed.
 */
function marketplaceV3Retired(fn: string): never {
  throw new Error(
    `${fn}() is unavailable: it queried the retired MarketplaceV3 subgraph on ` +
      `Polygon Amoy, which is decommissioned. Arbitrum Sepolia indexes no ` +
      `equivalent entity. Use src/lib/joymarketplace/drop_subgraph.ts for ` +
      `browse and detail reads.`,
  );
}

// ── Generic GraphQL fetcher ────────────────────────────────────────────────

async function querySubgraph<T>(
  endpoint: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const body = JSON.stringify({ query, variables });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Subgraph query failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { data?: T; errors?: { message: string }[] };

  if (json.errors?.length) {
    throw new Error(`Subgraph error: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("Subgraph returned no data");
  }

  return json.data;
}

// ── Drop subgraph queries ──────────────────────────────────────────────────

export async function getTokens(params?: SubgraphTokensParams): Promise<SubgraphToken[]> {
  const first = params?.first ?? 100;
  const skip = params?.skip ?? 0;
  const orderBy = params?.orderBy ?? "lazyMintedAt";
  const orderDirection = params?.orderDirection ?? "desc";

  const data = await querySubgraph<{ tokens: SubgraphToken[] }>(
    SUBGRAPH_URLS.drops,
    `query GetTokens($first: Int!, $skip: Int!, $orderBy: Token_orderBy!, $orderDirection: OrderDirection!) {
      tokens(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection) {
        id
        tokenId
        baseURI
        lazyMintedAt
        lazyMintBlock
        lazyMintTxHash
        pricePerToken
        currency
        maxClaimableSupply
        supplyClaimed
        quantityLimitPerWallet
        conditionStartTimestamp
        totalPurchases
      }
    }`,
    { first, skip, orderBy, orderDirection },
  );

  return data.tokens;
}

export async function getUserBalances(walletAddress: string, first = 100): Promise<SubgraphUserBalance[]> {
  const addr = walletAddress.toLowerCase();

  const data = await querySubgraph<{ userBalances: SubgraphUserBalance[] }>(
    SUBGRAPH_URLS.drops,
    `query GetUserBalances($user: String!, $first: Int!) {
      userBalances(where: { user: $user }, first: $first, orderBy: lastClaimedAt, orderDirection: desc) {
        id
        user
        tokenId
        totalClaimed
        lastClaimedAt
        token {
          id
          tokenId
          baseURI
          pricePerToken
          currency
          totalPurchases
          lazyMintedAt
        }
      }
    }`,
    { user: addr, first },
  );

  return data.userBalances;
}

export async function getUserPurchases(walletAddress: string, first = 100): Promise<SubgraphPurchase[]> {
  const addr = walletAddress.toLowerCase();

  const data = await querySubgraph<{ purchases: SubgraphPurchase[] }>(
    SUBGRAPH_URLS.drops,
    `query GetUserPurchases($claimer: String!, $first: Int!) {
      purchases(where: { claimer: $claimer }, first: $first, orderBy: timestamp, orderDirection: desc) {
        id
        tokenId
        claimConditionIndex
        claimer
        receiver
        quantity
        timestamp
        blockNumber
        txHash
      }
    }`,
    { claimer: addr, first },
  );

  return data.purchases;
}

export async function getDropStats(): Promise<SubgraphDropStats | null> {
  try {
    const data = await querySubgraph<{ dropStats: SubgraphDropStats[] }>(
      SUBGRAPH_URLS.drops,
      `{ dropStats(first: 1) { id totalTokens totalPurchases updatedAt } }`,
    );
    return data.dropStats?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Store subgraph queries ─────────────────────────────────────────────────

export async function getUserStores(walletAddress: string, first = 50): Promise<SubgraphStore[]> {
  const addr = walletAddress.toLowerCase();

  const data = await querySubgraph<{ stores: SubgraphStore[] }>(
    SUBGRAPH_URLS.stores,
    `query GetUserStores($owner: String!, $first: Int!) {
      stores(where: { owner: $owner }, first: $first, orderBy: createdAt, orderDirection: desc) {
        id
        domain
        owner
        name
        description
        logo
        website
        tagline
        isActive
        createdAt
        updatedAt
        textRecords {
          id
          key
          value
          updatedAt
        }
      }
    }`,
    { owner: addr, first },
  );

  return data.stores;
}

export async function getUserDomains(walletAddress: string, first = 50): Promise<SubgraphDomainRegistration[]> {
  const addr = walletAddress.toLowerCase();

  const data = await querySubgraph<{ domainRegistrations: SubgraphDomainRegistration[] }>(
    SUBGRAPH_URLS.stores,
    `query GetUserDomains($owner: String!, $first: Int!) {
      domainRegistrations(where: { owner: $owner }, first: $first, orderBy: registeredAt, orderDirection: desc) {
        id
        labelHash
        name
        fullName
        owner
        resolver
        resolvedAddress
        expiresAt
        registeredAt
        registeredTxHash
        cost
        textRecords {
          id
          key
          value
          updatedAt
        }
      }
    }`,
    { owner: addr, first },
  );

  return data.domainRegistrations;
}

export async function getAllStores(first = 100): Promise<SubgraphStore[]> {
  const data = await querySubgraph<{ stores: SubgraphStore[] }>(
    SUBGRAPH_URLS.stores,
    `query GetAllStores($first: Int!) {
      stores(first: $first, orderBy: createdAt, orderDirection: desc) {
        id
        domain
        owner
        name
        description
        logo
        website
        tagline
        isActive
        createdAt
        updatedAt
      }
    }`,
    { first },
  );

  return data.stores;
}

export async function getAllDomains(first = 100): Promise<SubgraphDomainRegistration[]> {
  const data = await querySubgraph<{ domainRegistrations: SubgraphDomainRegistration[] }>(
    SUBGRAPH_URLS.stores,
    `query GetAllDomains($first: Int!) {
      domainRegistrations(first: $first, orderBy: registeredAt, orderDirection: desc) {
        id
        name
        fullName
        owner
        resolvedAddress
        expiresAt
        registeredAt
        cost
      }
    }`,
    { first },
  );

  return data.domainRegistrations;
}

export async function getStoreStats(): Promise<SubgraphStoreStats | null> {
  try {
    const data = await querySubgraph<{ storeStats_collection: SubgraphStoreStats[] }>(
      SUBGRAPH_URLS.stores,
      `{ storeStats_collection(first: 1) { id totalDomains totalStores totalTextRecords updatedAt } }`,
    );
    return data.storeStats_collection?.[0] ?? null;
  } catch {
    return null;
  }
}

// ── Marketplace subgraph queries ───────────────────────────────────────────

/**
 * @deprecated MarketplaceV3 read path — retired 2026-05-02. Use
 * `listDrops` / `getDrop` from `lib/joymarketplace/drop_subgraph.ts`.
 * This helper still calls a subgraph that doesn't index DropERC1155 data
 * for our flow; expect empty/erroring results in production.
 */
export async function getMarketplaceAssets(params?: SubgraphAssetsParams): Promise<SubgraphAsset[]> {
  marketplaceV3Retired("getMarketplaceAssets");
}

/**
 * @deprecated MarketplaceV3 read path — retired 2026-05-02. There are no
 * marketplace "listings" anymore; ownership = DropERC1155 balance and
 * purchasability = `pricePerToken` on the token's claim conditions. Use
 * `listDrops` from `lib/joymarketplace/drop_subgraph.ts`.
 */
export async function getMarketplaceListings(params?: SubgraphListingsParams): Promise<SubgraphListing[]> {
  marketplaceV3Retired("getMarketplaceListings");
}

/**
 * @deprecated MarketplaceV3 read path — retired 2026-05-02.
 */
export async function getAIModels(params?: SubgraphAIModelsParams): Promise<SubgraphAIModel[]> {
  marketplaceV3Retired("getAIModels");
}

/**
 * @deprecated MarketplaceV3 read path — retired 2026-05-02.
 */
export async function getUserLicenses(walletAddress: string, first = 100): Promise<SubgraphAIModelLicense[]> {
  marketplaceV3Retired("getUserLicenses");
}

/**
 * @deprecated MarketplaceV3 read path — retired 2026-05-02.
 */
export async function getUserReceipts(walletAddress: string, first = 100): Promise<SubgraphReceipt[]> {
  marketplaceV3Retired("getUserReceipts");
}

/**
 * @deprecated MarketplaceV3 read path — retired 2026-05-02.
 */
export async function getMarketplaceStats(): Promise<SubgraphMarketplaceStats | null> {
  marketplaceV3Retired("getMarketplaceStats");
}

// ── Aggregated "My Assets" query ───────────────────────────────────────────

export async function getMyMarketplaceAssets(params: SubgraphQueryParams): Promise<MyMarketplaceAssets> {
  marketplaceV3Retired("getMyMarketplaceAssets");
}
