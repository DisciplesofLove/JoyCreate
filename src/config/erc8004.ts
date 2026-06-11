/**
 * ERC-8004 (Trustless Agents) — addresses & ABIs for the Arbitrum Stylus
 * registries:
 *   - IdentityRegistry   (agentId <-> domain <-> address)
 *   - ReputationRegistry (feedback authorization + aggregate scores)
 *   - ValidationRegistry (independent validation requests/responses)
 *
 * Deployed + initialized on Arbitrum Sepolia. See
 * /memories/repo/erc8004-deploy.md for tx hashes.
 */

import { envAddress } from "@/config/env_address";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const IDENTITY_REGISTRY_CONTRACTS = {
  arbitrumSepolia: "0x2168a88e613cd28409335eaa98e8aeed78d2e2ec",
  arbitrumOne: envAddress("VITE_IDENTITY_REGISTRY_ARB_ONE", ZERO_ADDRESS),
};

export const REPUTATION_REGISTRY_CONTRACTS = {
  arbitrumSepolia: "0x82718a9325ee5322cab83d5b7ee4ed060c19a626",
  arbitrumOne: envAddress("VITE_REPUTATION_REGISTRY_ARB_ONE", ZERO_ADDRESS),
};

export const VALIDATION_REGISTRY_CONTRACTS = {
  arbitrumSepolia: "0x9edcbf7f396dddb6e793b472661610772c7d68a6",
  arbitrumOne: envAddress("VITE_VALIDATION_REGISTRY_ARB_ONE", ZERO_ADDRESS),
};

export type Erc8004ChainId = keyof typeof IDENTITY_REGISTRY_CONTRACTS;

export const ERC8004_RPC: Record<Erc8004ChainId, string> = {
  arbitrumSepolia: "https://sepolia-rollup.arbitrum.io/rpc",
  arbitrumOne: "https://arb1.arbitrum.io/rpc",
};

export const ERC8004_CHAIN_IDS: Record<Erc8004ChainId, number> = {
  arbitrumSepolia: 421614,
  arbitrumOne: 42161,
};

export const DEFAULT_ERC8004_CHAIN: Erc8004ChainId = "arbitrumSepolia";

export function getIdentityRegistryAddress(chain: Erc8004ChainId): string {
  return IDENTITY_REGISTRY_CONTRACTS[chain];
}

export function getReputationRegistryAddress(chain: Erc8004ChainId): string {
  return REPUTATION_REGISTRY_CONTRACTS[chain];
}

export function getValidationRegistryAddress(chain: Erc8004ChainId): string {
  return VALIDATION_REGISTRY_CONTRACTS[chain];
}

export function isErc8004Ready(chain: Erc8004ChainId): boolean {
  return (
    IDENTITY_REGISTRY_CONTRACTS[chain] !== ZERO_ADDRESS &&
    REPUTATION_REGISTRY_CONTRACTS[chain] !== ZERO_ADDRESS &&
    VALIDATION_REGISTRY_CONTRACTS[chain] !== ZERO_ADDRESS
  );
}

/** ABI surface for the IdentityRegistry Stylus contract (camelCase selectors). */
export const IDENTITY_REGISTRY_ABI = [
  "function initialize()",
  "function agentCount() view returns (uint256)",
  "function newAgent(bytes agentDomain, address agentAddress) returns (uint256)",
  "function updateAgent(uint256 agentId, bytes newDomain, address newAddress) returns (bool)",
  "function getAgent(uint256 agentId) view returns (uint256, bytes, address)",
  "function resolveByAddress(address agentAddress) view returns (uint256)",
  "function resolveByDomainHash(bytes32 domainHash) view returns (uint256)",
  "event AgentRegistered(uint256 indexed agentId, address indexed agentAddress, bytes32 indexed domainHash, bytes agentDomain)",
  "event AgentUpdated(uint256 indexed agentId, address indexed agentAddress, bytes32 indexed domainHash, bytes agentDomain)",
] as const;

/** ABI surface for the ReputationRegistry Stylus contract. */
export const REPUTATION_REGISTRY_ABI = [
  "function initialize()",
  "function acceptFeedback(uint256 clientId, uint256 serverId)",
  "function submitFeedback(uint256 clientId, uint256 serverId, uint256 score, bytes feedbackUri)",
  "function isAuthorized(uint256 clientId, uint256 serverId) view returns (bool)",
  "function getScore(uint256 serverId) view returns (uint256, uint256)",
  "function averageScore(uint256 serverId) view returns (uint256)",
  "event AuthFeedback(uint256 indexed clientId, uint256 indexed serverId, address authorizedBy)",
  "event FeedbackSubmitted(uint256 indexed clientId, uint256 indexed serverId, uint256 score, bytes feedbackUri)",
] as const;

/** ABI surface for the ValidationRegistry Stylus contract. */
export const VALIDATION_REGISTRY_ABI = [
  "function initialize()",
  "function validationRequest(address validator, uint256 serverAgentId, bytes32 dataHash)",
  "function validationResponse(bytes32 dataHash, uint256 response)",
  "function getRequest(bytes32 dataHash) view returns (address, uint256, bool)",
  "function getResponse(bytes32 dataHash) view returns (bool, uint256)",
  "event ValidationRequest(bytes32 indexed dataHash, address indexed validator, uint256 indexed serverAgentId)",
  "event ValidationResponse(bytes32 indexed dataHash, address indexed validator, uint256 indexed serverAgentId, uint256 response)",
] as const;
