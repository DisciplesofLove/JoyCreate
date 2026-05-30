/**
 * Hierarchical ENS helpers for the JOY Marketplace namespace.
 *
 * The marketplace addresses agents, stores and assets under a single ENS
 * tree, e.g.:
 *
 *   marketplace.eth                      (root)
 *   <store>.store.marketplace.eth        (a storefront)
 *   <asset>.<store>.store.marketplace.eth (an asset under a store)
 *
 * Resolution uses ethers' built-in CCIP-read (EIP-3668) support: when a
 * resolver returns an `OffchainLookup` revert, ethers automatically queries
 * the off-chain gateway and verifies the response. This lets large,
 * gas-free subtrees (one entry per asset) live off-chain while remaining
 * trustlessly resolvable.
 *
 * NOTE: `labelHash(label)` is exactly the `keccak256(utf8(label))` value that
 * `StoreRegistry.resolveBySlugHash` expects, so an ENS label and a store slug
 * share the same hash.
 */

import { ethers } from "ethers";

/** The root ENS name for the marketplace namespace. */
export const MARKETPLACE_ROOT = "marketplace.eth";

/** The label under which storefronts are registered. */
export const STORE_LABEL = "store";

/** keccak256 of the empty/zero node — the ENS root node. */
export const ROOT_NODE = ethers.ZeroHash;

/** ENS namehash of a full name (e.g. `foo.store.marketplace.eth`). */
export function namehash(name: string): string {
  return ethers.namehash(name);
}

/** keccak256(utf8(label)) — a single ENS label hash (a.k.a. store slug hash). */
export function labelHash(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

/** DNS wire-format encoding of a name (used by wildcard / CCIP resolvers). */
export function dnsEncode(name: string): string {
  return ethers.dnsEncode(name);
}

/** Build the fully-qualified ENS name for a storefront. */
export function storeName(storeSlug: string, root: string = MARKETPLACE_ROOT): string {
  return `${storeSlug}.${STORE_LABEL}.${root}`;
}

/** Build the fully-qualified ENS name for an asset under a store. */
export function assetName(
  assetSlug: string,
  storeSlug: string,
  root: string = MARKETPLACE_ROOT,
): string {
  return `${assetSlug}.${storeName(storeSlug, root)}`;
}

/** The namehash node for a storefront name. */
export function storeNode(storeSlug: string, root: string = MARKETPLACE_ROOT): string {
  return namehash(storeName(storeSlug, root));
}

/** The namehash node for an asset name. */
export function assetNode(
  assetSlug: string,
  storeSlug: string,
  root: string = MARKETPLACE_ROOT,
): string {
  return namehash(assetName(assetSlug, storeSlug, root));
}

/**
 * Resolve an ENS name to an address using CCIP-read (EIP-3668). Returns null
 * if the name has no resolver or no address record.
 */
export async function resolveAddress(
  name: string,
  provider: ethers.Provider,
): Promise<string | null> {
  return provider.resolveName(name);
}

/**
 * Resolve an ENS text record (e.g. `agent-id`, `url`, `avatar`) for a name,
 * following CCIP-read for off-chain resolvers. Returns null if unset.
 */
export async function resolveText(
  name: string,
  key: string,
  provider: ethers.Provider,
): Promise<string | null> {
  const resolver = await provider.getResolver(name);
  if (!resolver) return null;
  return resolver.getText(key);
}

/**
 * Look up the resolver contract address for a name. Useful for verifying that
 * a hierarchical subtree is wired to the CCIP gateway resolver.
 */
export async function getResolverAddress(
  name: string,
  provider: ethers.Provider,
): Promise<string | null> {
  const resolver = await provider.getResolver(name);
  return resolver ? resolver.address : null;
}
