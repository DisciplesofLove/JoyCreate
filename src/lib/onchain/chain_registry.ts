/**
 * Marketplace chain registry.
 *
 * Resolves a `MarketplaceChainId` settings value into the concrete chain config,
 * contract addresses, ABI, and currency descriptor used by the publisher,
 * orchestrator, and on-chain listener.
 *
 * Default is "arbitrumSepolia" — the Web 4.0 stack (StoreRegistry +
 * EditionController + ERC-1144 broker + x402 USDC rail) is deployed there.
 * Switching to another value via Settings → Marketplace network is additive:
 * previously published items are not migrated or hidden.
 */

import {
  AMOY_ENS_CONTRACTS,
  ARB_SEPOLIA_ENS_CONTRACTS,
  ARB_SEPOLIA_PARENT_DOMAIN,
  ARBITRUM_ONE,
  ARBITRUM_ONE_STYLUS_CONTRACTS,
  ARBITRUM_SEPOLIA,
  CONTRACT_ADDRESSES,
  NATIVE_TOKEN_SENTINEL,
  POLYGON_AMOY,
  STYLUS_DROP_ABI,
} from "@/config/joymarketplace";
import { GOLDSKY_SUBGRAPHS } from "@/config/subgraphs";

export type MarketplaceChainId = "polygonAmoy" | "arbitrumSepolia" | "arbitrumOne";

export const DEFAULT_MARKETPLACE_CHAIN: MarketplaceChainId = "arbitrumSepolia";

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
    /** DropERC1155 proxy — the address subgraph events come from. */
    dropEdition: string;
    /** JoyCreatorGate — the address creators ACTUALLY call to mint. */
    creatorGate: string;
    /** ENS parent domain (e.g. "joy" on Amoy, "joymarketplace.io" on Arb). */
    ensParentDomain: string;
    /** ENS BaseRegistrar ERC-721 — owns 2LD tokens. */
    ensBaseRegistrar: string;
  };
  abi: readonly string[];
  /** Goldsky subgraph URLs for this chain. */
  subgraph: {
    drop: string;
    stores: string;
  };
  /** Pricing currency for new mints / listings. */
  currency: "USDC" | "ETH";
  /**
   * ERC-20 address for the currency, or the native-token sentinel
   * (`0xEEEe…eeEE`) when paying in the chain's native coin.
   */
  currencyAddress: string;
  /** Decimals used to scale UI dollar / ether amounts to base units. */
  currencyDecimals: number;
  /** True when JoyCreatorGate (.joy ENS) gating must be enforced before mint. */
  enforceJoyCreatorGate: boolean;
  /** Testnet flag — drives UI banners / disables mainnet warnings. */
  isTestnet: boolean;
}

// DropERC1155 ABI used by the listener — kept inline so this module does not
// introduce a circular import with drop_event_listener.ts. Used by BOTH Amoy
// and Arbitrum Sepolia (both chains now mint via DropERC1155 proxies).
const DROP_ERC1155_EVENT_ABI = [
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
        contracts: {
          dropEdition: AMOY_ENS_CONTRACTS.platformDrop,
          creatorGate: AMOY_ENS_CONTRACTS.JoyCreatorGate,
          ensParentDomain: "joy",
          ensBaseRegistrar: AMOY_ENS_CONTRACTS.BaseRegistrar,
        },
        abi: DROP_ERC1155_EVENT_ABI,
        subgraph: {
          drop: GOLDSKY_SUBGRAPHS.polygonAmoy.drop,
          stores: GOLDSKY_SUBGRAPHS.polygonAmoy.stores,
        },
        currency: "USDC",
        currencyAddress: CONTRACT_ADDRESSES.USDC_POLYGON,
        currencyDecimals: 6,
        enforceJoyCreatorGate: true,
        isTestnet: true,
      };
    case "arbitrumSepolia":
      return {
        id: "arbitrumSepolia",
        chain: ARBITRUM_SEPOLIA,
        contracts: {
          // Marketplace canonical — DropERC1155 proxy + gate, NOT the legacy
          // Stylus EditionDrop contract (0x016950…003e8).
          dropEdition: ARB_SEPOLIA_ENS_CONTRACTS.platformDrop,
          creatorGate: ARB_SEPOLIA_ENS_CONTRACTS.JoyCreatorGate,
          ensParentDomain: ARB_SEPOLIA_PARENT_DOMAIN,
          ensBaseRegistrar: ARB_SEPOLIA_ENS_CONTRACTS.BaseRegistrar,
        },
        abi: DROP_ERC1155_EVENT_ABI,
        subgraph: {
          drop: GOLDSKY_SUBGRAPHS.arbitrumSepolia.drop,
          stores: GOLDSKY_SUBGRAPHS.arbitrumSepolia.stores,
        },
        currency: "ETH",
        currencyAddress: NATIVE_TOKEN_SENTINEL,
        currencyDecimals: 18,
        enforceJoyCreatorGate: true,
        isTestnet: true,
      };
    case "arbitrumOne":
      return {
        id: "arbitrumOne",
        chain: ARBITRUM_ONE,
        contracts: {
          dropEdition: ARBITRUM_ONE_STYLUS_CONTRACTS.dropEdition,
          creatorGate: ZERO_ADDRESS,
          ensParentDomain: "joymarketplace.io",
          ensBaseRegistrar: ZERO_ADDRESS,
        },
        abi: STYLUS_DROP_ABI,
        subgraph: {
          drop: GOLDSKY_SUBGRAPHS.arbitrumOne.drop,
          stores: GOLDSKY_SUBGRAPHS.arbitrumOne.stores,
        },
        currency: "ETH",
        currencyAddress: NATIVE_TOKEN_SENTINEL,
        currencyDecimals: 18,
        enforceJoyCreatorGate: false,
        isTestnet: false,
      };
  }
}

/**
 * True when the resolved drop contract AND creator gate have been deployed
 * (i.e. are not placeholder zero-addresses). Callers SHOULD refuse to
 * publish/listen on a chain whose contracts are not yet wired.
 */
export function isMarketplaceChainReady(id: MarketplaceChainId): boolean {
  const cfg = getMarketplaceChain(id);
  const dropOk =
    typeof cfg.contracts.dropEdition === "string" &&
    cfg.contracts.dropEdition.toLowerCase() !== ZERO_ADDRESS;
  if (!cfg.enforceJoyCreatorGate) return dropOk;
  const gateOk =
    typeof cfg.contracts.creatorGate === "string" &&
    cfg.contracts.creatorGate.toLowerCase() !== ZERO_ADDRESS;
  return dropOk && gateOk;
}
