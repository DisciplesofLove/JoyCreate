/**
 * JNS (Joy Name System) resolver — read-only resolution of `.joy` names.
 *
 * JNS is JoyCreate's name system: human-readable names (e.g. `alice.joy`) that
 * map to a wallet address + creator text records. It is the sibling of ENS —
 * ENS resolves `.eth` names via the standard ETH registrar, while JNS resolves
 * `.joy` names via the Joy ENS fork (an ENSRegistry + JoyResolver pair). Both
 * are first-class identity name systems; this module keeps JNS resolvable
 * after the identity refactor consolidated the legacy DID/JNS hub.
 *
 * The `.joy` TLD is deployed on Polygon Amoy; the Arbitrum Sepolia deployment
 * hangs names off `joymarketplace.io`. Both use the same ENSRegistry +
 * JoyResolver interfaces, so resolution is identical save the parent domain.
 *
 * Reads only — no signing, no writes. Uses the standard ENS read interfaces
 * (`owner`, `resolver`, `addr`, `text`), so it is safe against any ENS-shaped
 * registry. An unregistered name resolves to `{ registered: false }` rather
 * than throwing; only hard RPC failures throw.
 */

import { ethers } from "ethers";

import {
  AMOY_ENS_CONTRACTS,
  ARB_SEPOLIA_ENS_CONTRACTS,
  ARB_SEPOLIA_PARENT_DOMAIN,
  ARBITRUM_SEPOLIA,
  POLYGON_AMOY,
} from "@/config/joymarketplace";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Chains where the Joy ENS (.joy / joymarketplace.io) registry is deployed. */
export type JnsChainId = "polygonAmoy" | "arbitrumSepolia";

interface JnsChainConfig {
  rpcUrl: string;
  ensRegistry: string;
  joyResolver: string;
  /** Parent domain JNS names hang off (e.g. "joy" on Amoy). */
  parentDomain: string;
}

const JNS_CHAINS: Record<JnsChainId, JnsChainConfig> = {
  polygonAmoy: {
    rpcUrl: POLYGON_AMOY.rpcUrl,
    ensRegistry: AMOY_ENS_CONTRACTS.ENSRegistry,
    joyResolver: AMOY_ENS_CONTRACTS.JoyResolver,
    parentDomain: "joy",
  },
  arbitrumSepolia: {
    rpcUrl: ARBITRUM_SEPOLIA.rpcUrl,
    ensRegistry: ARB_SEPOLIA_ENS_CONTRACTS.ENSRegistry,
    joyResolver: ARB_SEPOLIA_ENS_CONTRACTS.JoyResolver,
    parentDomain: ARB_SEPOLIA_PARENT_DOMAIN,
  },
};

/** The canonical home of the `.joy` TLD (JNS). */
export const DEFAULT_JNS_CHAIN: JnsChainId = "polygonAmoy";

const ENS_REGISTRY_ABI = [
  "function owner(bytes32 node) view returns (address)",
  "function resolver(bytes32 node) view returns (address)",
] as const;

const JOY_RESOLVER_ABI = [
  "function addr(bytes32 node) view returns (address)",
  "function text(bytes32 node, string key) view returns (string)",
] as const;

/** Canonical JoyResolver text-record keys surfaced by a JNS lookup. */
const TEXT_RECORD_KEYS: Record<keyof JnsRecords, string> = {
  name: "name",
  avatar: "avatar",
  url: "url",
  description: "description",
  storeId: "joy.storeId",
  storeName: "joy.storeName",
};

export interface JnsRecords {
  name?: string;
  avatar?: string;
  url?: string;
  description?: string;
  storeId?: string;
  storeName?: string;
}

export interface JnsResolution {
  /** Fully-qualified name that was resolved (e.g. "alice.joy"). */
  name: string;
  /** ENS namehash node for the name. */
  node: string;
  /** Chain the lookup ran against. */
  chain: JnsChainId;
  /** True when the name has an owner (is registered). */
  registered: boolean;
  /** ENS registry owner of the name, or null when unregistered. */
  owner: string | null;
  /** Resolver `addr(node)` record, or null when unset. */
  address: string | null;
  /** JoyResolver text records. */
  records: JnsRecords;
}

function isJnsChainId(value: unknown): value is JnsChainId {
  return value === "polygonAmoy" || value === "arbitrumSepolia";
}

/** Choose the chain whose parent domain matches the name's suffix. */
function pickChainForName(name: string): JnsChainId {
  const lower = name.toLowerCase();
  if (lower.endsWith(`.${ARB_SEPOLIA_PARENT_DOMAIN}`)) return "arbitrumSepolia";
  // ".joy" names (and bare labels, normalized to ".joy") live on Amoy.
  return DEFAULT_JNS_CHAIN;
}

/** Normalize a user-supplied name to a fully-qualified JNS name for `chain`. */
function normalizeName(raw: string, chain: JnsChainId): string {
  const trimmed = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) throw new Error("JNS name is required");
  if (!trimmed.includes(".")) {
    return `${trimmed}.${JNS_CHAINS[chain].parentDomain}`;
  }
  return trimmed;
}

/**
 * Resolve a JNS name to its owner, address, and creator text records.
 *
 * @param rawName  A `.joy` name (or bare label, normalized to `.joy`).
 * @param chainArg Explicit chain; otherwise inferred from the name suffix.
 */
export async function resolveJoyName(
  rawName: string,
  chainArg?: JnsChainId,
): Promise<JnsResolution> {
  if (typeof rawName !== "string" || !rawName.trim()) {
    throw new Error("JNS name is required");
  }
  const chain: JnsChainId = isJnsChainId(chainArg)
    ? chainArg
    : pickChainForName(rawName);
  const cfg = JNS_CHAINS[chain];
  const name = normalizeName(rawName, chain);
  const node = ethers.namehash(name);

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const registry = new ethers.Contract(cfg.ensRegistry, ENS_REGISTRY_ABI, provider);

  let owner: string;
  try {
    owner = (await registry.owner(node)) as string;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`JNS registry lookup failed for ${name}: ${message}`);
  }

  const registered = owner !== ZERO_ADDRESS && owner !== "0x";
  if (!registered) {
    return { name, node, chain, registered: false, owner: null, address: null, records: {} };
  }

  const resolver = new ethers.Contract(cfg.joyResolver, JOY_RESOLVER_ABI, provider);

  let address: string | null = null;
  try {
    const addr = (await resolver.addr(node)) as string;
    address = addr && addr !== ZERO_ADDRESS ? addr : null;
  } catch {
    // addr record unset or resolver is CCIP-only — best effort.
  }

  const records: JnsRecords = {};
  const entries = Object.entries(TEXT_RECORD_KEYS) as [keyof JnsRecords, string][];
  await Promise.all(
    entries.map(async ([field, key]) => {
      try {
        const value = (await resolver.text(node, key)) as string;
        if (value) records[field] = value;
      } catch {
        // record unset / CCIP-only — skip.
      }
    }),
  );

  return { name, node, chain, registered: true, owner, address, records };
}
