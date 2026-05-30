/**
 * X402 pay-per-prompt rail — addresses, network config and the 80/10/10
 * revenue split.
 *
 * Settlement asset is USDC (Circle, EIP-3009 `transferWithAuthorization`) on
 * Arbitrum Sepolia. Payments are routed to the RevenueSplitter, which fans
 * out 80% creator / 10% platform / 10% protocol.
 *
 * See /memories/repo/x402-deploy.md for deploy tx hashes.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Canonical x402 network identifiers. */
export type X402Network = "arbitrum-sepolia" | "arbitrum-one";

export type X402ChainId = "arbitrumSepolia" | "arbitrumOne";

export const X402_NETWORK_BY_CHAIN: Record<X402ChainId, X402Network> = {
  arbitrumSepolia: "arbitrum-sepolia",
  arbitrumOne: "arbitrum-one",
};

export const X402_RPC: Record<X402ChainId, string> = {
  arbitrumSepolia: "https://sepolia-rollup.arbitrum.io/rpc",
  arbitrumOne: "https://arb1.arbitrum.io/rpc",
};

export const X402_CHAIN_IDS: Record<X402ChainId, number> = {
  arbitrumSepolia: 421614,
  arbitrumOne: 42161,
};

/** Circle USDC (EIP-3009 capable). */
export const USDC_CONTRACTS: Record<X402ChainId, string> = {
  arbitrumSepolia: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  arbitrumOne: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};

export const USDC_DECIMALS = 6;

/** RevenueSplitter — receives the X402 payment and fans out 80/10/10. */
export const REVENUE_SPLITTER_CONTRACTS: Record<X402ChainId, string> = {
  arbitrumSepolia: "0x34fa204ca5db1a25a0003b1c7b45ab9c858d63bf",
  arbitrumOne: ZERO_ADDRESS,
};

/** Split in basis points (must match the on-chain RevenueSplitter config). */
export const REVENUE_SPLIT_BPS = {
  creator: 8000,
  platform: 1000,
  protocol: 1000,
} as const;

export const DEFAULT_X402_CHAIN: X402ChainId = "arbitrumSepolia";

/** Current x402 protocol version. */
export const X402_VERSION = 1;

export function getUsdcAddress(chain: X402ChainId): string {
  return USDC_CONTRACTS[chain];
}

export function getRevenueSplitterAddress(chain: X402ChainId): string {
  return REVENUE_SPLITTER_CONTRACTS[chain];
}

export function isX402Ready(chain: X402ChainId): boolean {
  return (
    REVENUE_SPLITTER_CONTRACTS[chain] !== ZERO_ADDRESS &&
    USDC_CONTRACTS[chain] !== ZERO_ADDRESS
  );
}

/** Convert a human USDC amount (e.g. "0.25") to atomic base units (6dp). */
export function usdcToAtomic(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || "0");
}

/** Convert atomic USDC base units to a human-readable decimal string. */
export function atomicToUsdc(atomic: bigint | string): string {
  const v = BigInt(atomic);
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = v / base;
  const frac = (v % base).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Compute the 80/10/10 split for an atomic amount (protocol gets remainder). */
export function computeSplit(amount: bigint): {
  creator: bigint;
  platform: bigint;
  protocol: bigint;
} {
  const creator = (amount * BigInt(REVENUE_SPLIT_BPS.creator)) / 10000n;
  const platform = (amount * BigInt(REVENUE_SPLIT_BPS.platform)) / 10000n;
  const protocol = amount - creator - platform;
  return { creator, platform, protocol };
}

/** Minimal EIP-3009 ABI surface for USDC settlement. */
export const USDC_EIP3009_ABI = [
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
] as const;

/** RevenueSplitter ABI surface. */
export const REVENUE_SPLITTER_ABI = [
  "function initialize(address platformWallet, address protocolWallet)",
  "function owner() view returns (address)",
  "function setWallets(address platformWallet, address protocolWallet) returns (bool)",
  "function distribute(address token, address creator, uint256 amount) returns (bool)",
  "function distributeAll(address token, address creator) returns (bool)",
  "function creatorEarnings(address token, address creator) view returns (uint256)",
  "function totalDistributed(address token) view returns (uint256)",
  "function getConfig() view returns (address, address, address, uint256, uint256, uint256)",
  "event RevenueSplit(address indexed token, address indexed creator, uint256 amount, uint256 creatorAmount, uint256 platformAmount, uint256 protocolAmount)",
  "event WalletsUpdated(address platformWallet, address protocolWallet)",
] as const;
