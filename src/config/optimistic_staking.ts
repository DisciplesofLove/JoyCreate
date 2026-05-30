/**
 * OptimisticStaking — bonded, challengeable attestations for the
 * verifiable-inference "optimistic" provider (P6).
 *
 * A validator stakes ERC-20 (USDC) and posts a signed attestation over an
 * inference `digest`. The attestation is accepted optimistically and finalizes
 * after a challenge window unless a fraud proof (`challengeSignature`) or a
 * content dispute (`openDispute` / `resolveDispute`) slashes the bond.
 *
 * Deployed + initialized on Arbitrum Sepolia. See
 * /memories/repo/optimistic-staking-stylus.md for tx hashes.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const OPTIMISTIC_STAKING_CONTRACTS = {
  arbitrumSepolia: "0x5f587e50a9de2409e5f43d70dc0a22b88bf61904",
  arbitrumOne: ZERO_ADDRESS,
} as const;

export type OptimisticStakingChainId = keyof typeof OPTIMISTIC_STAKING_CONTRACTS;

export const OPTIMISTIC_STAKING_RPC: Record<OptimisticStakingChainId, string> = {
  arbitrumSepolia: "https://sepolia-rollup.arbitrum.io/rpc",
  arbitrumOne: "https://arb1.arbitrum.io/rpc",
};

export const OPTIMISTIC_STAKING_CHAIN_IDS: Record<OptimisticStakingChainId, number> = {
  arbitrumSepolia: 421614,
  arbitrumOne: 42161,
};

export const DEFAULT_OPTIMISTIC_STAKING_CHAIN: OptimisticStakingChainId = "arbitrumSepolia";

/** Attestation lifecycle status codes (mirror the on-chain constants). */
export const ATTESTATION_STATUS = {
  none: 0,
  pending: 1,
  finalized: 2,
  slashed: 3,
  disputed: 4,
} as const;

/** Slash reason codes (mirror the on-chain constants). */
export const SLASH_REASON = {
  badSignature: 1,
  lostDispute: 2,
} as const;

export function getOptimisticStakingAddress(chain: OptimisticStakingChainId): string {
  return OPTIMISTIC_STAKING_CONTRACTS[chain];
}

export function isOptimisticStakingReady(chain: OptimisticStakingChainId): boolean {
  return OPTIMISTIC_STAKING_CONTRACTS[chain] !== ZERO_ADDRESS;
}

/**
 * ABI surface for the OptimisticStaking Stylus contract (camelCase selectors).
 * Note: `submitAttestation` takes fixed ECDSA components (r, s, v) rather than
 * a dynamic `bytes` blob — the contract verifies a RAW ECDSA signature over the
 * 32-byte digest (no EIP-191 prefix).
 */
export const OPTIMISTIC_STAKING_ABI = [
  "function initialize(address stakeToken, address arbiter, uint256 minStake, uint256 challengeWindow)",
  "function setParams(address arbiter, uint256 minStake, uint256 challengeWindow)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function submitAttestation(bytes32 digest, address signer, uint256 score, uint256 bond, bytes32 r, bytes32 s, uint8 v)",
  "function challengeSignature(bytes32 digest)",
  "function openDispute(bytes32 digest)",
  "function resolveDispute(bytes32 digest, bool validatorSlashed)",
  "function finalize(bytes32 digest)",
  "function getAttestation(bytes32 digest) view returns (address submitter, address signer, uint256 score, uint256 bond, uint256 deadline, uint256 status)",
  "function stakeOf(address validator) view returns (uint256 stake, uint256 locked)",
  "function getConfig() view returns (address owner, address arbiter, address stakeToken, uint256 minStake, uint256 challengeWindow)",
  "event StakeChanged(address indexed validator, uint256 newStake, uint256 locked)",
  "event AttestationSubmitted(bytes32 indexed digest, address indexed submitter, address indexed signer, uint256 score, uint256 bond, uint256 deadline)",
  "event Slashed(bytes32 indexed digest, address indexed submitter, address indexed to, uint256 amount, uint256 reason)",
  "event DisputeOpened(bytes32 indexed digest, address indexed challenger, uint256 bond)",
  "event DisputeResolved(bytes32 indexed digest, bool validatorSlashed)",
  "event Finalized(bytes32 indexed digest, address indexed submitter, uint256 score)",
] as const;
