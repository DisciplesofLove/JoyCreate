/**
 * JOY Marketplace "glue" contracts — addresses & ABIs for the Arbitrum Stylus
 * contracts that connect storefronts, drops and autonomous agents:
 *   - StoreRegistry     (storeId <-> owner <-> ERC-8004 agentId <-> slug)
 *   - EditionController (drop factory + PoU-gated mint entrypoint)
 *   - AgentMandate      (delegated spend limits / action scope / time-gate)
 *
 * Deployed + initialized on Arbitrum Sepolia. See
 * /memories/repo/glue-contracts-deploy.md for tx hashes.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const STORE_REGISTRY_CONTRACTS = {
  arbitrumSepolia: "0x2e6f02271ae08250d2c87f4fa02eb468f4abe3e4",
  arbitrumOne: ZERO_ADDRESS,
} as const;

export const EDITION_CONTROLLER_CONTRACTS = {
  arbitrumSepolia: "0x93b334ce8043195d57259c55ca2b336e63c17255",
  arbitrumOne: ZERO_ADDRESS,
} as const;

export const AGENT_MANDATE_CONTRACTS = {
  arbitrumSepolia: "0xe326ec664c22ac6adde0215e619fe8aece669408",
  arbitrumOne: ZERO_ADDRESS,
} as const;

export type GlueChainId = keyof typeof STORE_REGISTRY_CONTRACTS;

export const GLUE_RPC: Record<GlueChainId, string> = {
  arbitrumSepolia: "https://sepolia-rollup.arbitrum.io/rpc",
  arbitrumOne: "https://arb1.arbitrum.io/rpc",
};

export const GLUE_CHAIN_IDS: Record<GlueChainId, number> = {
  arbitrumSepolia: 421614,
  arbitrumOne: 42161,
};

export const DEFAULT_GLUE_CHAIN: GlueChainId = "arbitrumSepolia";

export function getStoreRegistryAddress(chain: GlueChainId): string {
  return STORE_REGISTRY_CONTRACTS[chain];
}

export function getEditionControllerAddress(chain: GlueChainId): string {
  return EDITION_CONTROLLER_CONTRACTS[chain];
}

export function getAgentMandateAddress(chain: GlueChainId): string {
  return AGENT_MANDATE_CONTRACTS[chain];
}

export function isGlueReady(chain: GlueChainId): boolean {
  return (
    STORE_REGISTRY_CONTRACTS[chain] !== ZERO_ADDRESS &&
    EDITION_CONTROLLER_CONTRACTS[chain] !== ZERO_ADDRESS &&
    AGENT_MANDATE_CONTRACTS[chain] !== ZERO_ADDRESS
  );
}

/** ABI surface for the StoreRegistry Stylus contract (camelCase selectors). */
export const STORE_REGISTRY_ABI = [
  "function initialize()",
  "function storeCount() view returns (uint256)",
  "function registerStore(bytes slug, uint256 agentId) returns (uint256)",
  "function setAgent(uint256 storeId, uint256 agentId) returns (bool)",
  "function transferStore(uint256 storeId, address newOwner) returns (bool)",
  "function getStore(uint256 storeId) view returns (uint256, address, uint256, bytes)",
  "function resolveBySlugHash(bytes32 slugHash) view returns (uint256)",
  "event StoreRegistered(uint256 indexed storeId, address indexed owner, uint256 indexed agentId, bytes32 slugHash, bytes slug)",
  "event StoreAgentUpdated(uint256 indexed storeId, address indexed owner, uint256 indexed agentId)",
  "event StoreTransferred(uint256 indexed storeId, address indexed from, address indexed to)",
] as const;

/** ABI surface for the EditionController Stylus contract. */
export const EDITION_CONTROLLER_ABI = [
  "function initialize()",
  "function owner() view returns (address)",
  "function dropCount() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function createDrop(uint256 storeId, bytes32 assetLeaf, uint256 price, uint256 maxSupply, bool requiresProof) returns (uint256)",
  "function setActive(uint256 dropId, bool active) returns (bool)",
  "function grantProof(uint256 dropId, address account) returns (bool)",
  "function mint(uint256 dropId) returns (uint256)",
  "function getDrop(uint256 dropId) view returns (address, uint256, bytes32, uint256, uint256, uint256, bool, bool)",
  "function balanceOf(uint256 dropId, address account) view returns (uint256)",
  "function isProofGranted(uint256 dropId, address account) view returns (bool)",
  "event DropCreated(uint256 indexed dropId, address indexed creator, uint256 indexed storeId, bytes32 assetLeaf, uint256 price, uint256 maxSupply, bool requiresProof)",
  "event DropActivated(uint256 indexed dropId, bool active)",
  "event ProofGranted(uint256 indexed dropId, address indexed account)",
  "event Minted(uint256 indexed dropId, uint256 indexed tokenId, address indexed to, uint256 price)",
] as const;

/** ABI surface for the AgentMandate Stylus contract. */
export const AGENT_MANDATE_ABI = [
  "function initialize()",
  "function mandateCount() view returns (uint256)",
  "function createMandate(address agent, uint256 spendLimit, uint256 expiry, bytes32 actionScope) returns (uint256)",
  "function recordSpend(uint256 mandateId, uint256 amount) returns (uint256)",
  "function revokeMandate(uint256 mandateId) returns (bool)",
  "function isValid(uint256 mandateId) view returns (bool)",
  "function canSpend(uint256 mandateId, uint256 amount) view returns (bool)",
  "function remaining(uint256 mandateId) view returns (uint256)",
  "function getMandate(uint256 mandateId) view returns (address, address, uint256, uint256, uint256, bytes32, bool)",
  "event MandateCreated(uint256 indexed mandateId, address indexed principal, address indexed agent, uint256 spendLimit, uint256 expiry, bytes32 actionScope)",
  "event MandateSpent(uint256 indexed mandateId, address indexed agent, uint256 amount, uint256 totalSpent)",
  "event MandateRevoked(uint256 indexed mandateId, address indexed principal)",
] as const;
