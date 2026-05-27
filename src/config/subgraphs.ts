/**
 * Pure subgraph endpoint config + GraphQL helper.
 *
 * This module deliberately has NO thirdweb / wagmi / viem imports so it is
 * safe to import from both the Electron main process and the renderer.
 * (Pulling `@/config/thirdweb` into the main bundle drags the thirdweb v5
 * SDK along with it, which breaks `vite.main.config.mts`.)
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
