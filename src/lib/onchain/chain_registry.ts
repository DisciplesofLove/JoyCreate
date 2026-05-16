/**
 * Marketplace chain registry.
 *
 * Resolves a `MarketplaceChainId` settings value into the concrete chain config,
 * contract addresses, ABI, and currency descriptor used by the publisher,
 * orchestrator, and on-chain listener.
 *
 * Default is "polygonAmoy" — switching to any Arbitrum value is opt-in via
 * Settings → Marketplace network and is purely additive: no existing
 * Polygon-pinned items are touched.
 */

import {
  AMOY_ENS_CONTRACTS,
  ARBITRUM_ONE,
  ARBITRUM_ONE_STYLUS_CONTRACTS,
  ARBITRUM_SEPOLIA,
  ARBITRUM_SEPOLIA_STYLUS_CONTRACTS,
  CONTRACT_ADDRESSES,
  POLYGON_AMOY,
  STYLUS_DROP_ABI,
} from "@/config/joymarketplace";

export type MarketplaceChainId = "polygonAmoy" | "arbitrumSepolia" | "arbitrumOne";

export const DEFAULT_MARKETPLACE_CHAIN: MarketplaceChainId = "polygonAmoy";

export interface MarketplaceChainConfig {
  id: MarketplaceChainId;
  chain: {
    chainId: number;
    chainIdHex: string;
    name: string;
    rpcUrl: string;
    blockExplorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
  };
  contracts: {
    /** Drop / edition ERC-1155 contract — the mint target. */
    dropEdition: string;
  };
  abi: readonly string[];
  /** Pricing currency for new mints / listings. */
  currency: "USDC" | "ETH";
  /** ERC-20 address for the currency, or null when paying in native ETH. */
  currencyAddress: string | null;
  /** Decimals used to scale UI dollar / ether amounts to base units. */
  currencyDecimals: number;
  /** True when JoyCreatorGate (.joy ENS) gating must be enforced before mint. */
  enforceJoyCreatorGate: boolean;
}

// Polygon Amoy ABI used by the existing listener — kept inline so this module
// does not introduce a circular import with drop_event_listener.ts.
const AMOY_DROP_ABI = [
  "event TokensClaimed(uint256 indexed claimConditionIndex, address indexed claimer, address indexed receiver, uint256 tokenId, uint256 quantityClaimed)",
  "event TokensLazyMinted(uint256 startTokenId, uint256 endTokenId, string baseURI, bytes encryptedBaseURI)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isMarketplaceChainId(value: unknown): value is MarketplaceChainId {
  return value === "polygonAmoy" || value === "arbitrumSepolia" || value === "arbitrumOne";
}

export function getMarketplaceChain(id: MarketplaceChainId): MarketplaceChainConfig {
  switch (id) {
    case "polygonAmoy":
      return {
        id: "polygonAmoy",
        chain: POLYGON_AMOY,
        contracts: { dropEdition: AMOY_ENS_CONTRACTS.platformDrop },
        abi: AMOY_DROP_ABI,
        currency: "USDC",
        currencyAddress: CONTRACT_ADDRESSES.USDC_POLYGON,
        currencyDecimals: 6,
        enforceJoyCreatorGate: true,
      };
    case "arbitrumSepolia":
      return {
        id: "arbitrumSepolia",
        chain: ARBITRUM_SEPOLIA,
        contracts: { dropEdition: ARBITRUM_SEPOLIA_STYLUS_CONTRACTS.dropEdition },
        abi: STYLUS_DROP_ABI,
        currency: "ETH",
        currencyAddress: null,
        currencyDecimals: 18,
        enforceJoyCreatorGate: false,
      };
    case "arbitrumOne":
      return {
        id: "arbitrumOne",
        chain: ARBITRUM_ONE,
        contracts: { dropEdition: ARBITRUM_ONE_STYLUS_CONTRACTS.dropEdition },
        abi: STYLUS_DROP_ABI,
        currency: "ETH",
        currencyAddress: null,
        currencyDecimals: 18,
        enforceJoyCreatorGate: false,
      };
  }
}

/**
 * True when the resolved drop contract has been deployed (i.e. is not the
 * placeholder zero-address). Callers SHOULD refuse to publish/listen on a
 * chain whose contract is not yet wired.
 */
export function isMarketplaceChainReady(id: MarketplaceChainId): boolean {
  const cfg = getMarketplaceChain(id);
  return (
    typeof cfg.contracts.dropEdition === "string" &&
    cfg.contracts.dropEdition.toLowerCase() !== ZERO_ADDRESS
  );
}
