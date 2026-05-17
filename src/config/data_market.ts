/**
 * Data Market — addresses & ABIs for the Arbitrum Stylus
 *   - DataProvenance contract (provenance / "human stamp" tokens)
 *   - DataLease contract (smart-lease exchange)
 *
 * Filled in after deploy. Until then the IPC handlers refuse to send writes
 * and return descriptive errors instead.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const DATA_PROVENANCE_CONTRACTS = {
  arbitrumSepolia: "0xe6c66de70de8cfba8129db78ff81d36d7de0ccb8",
  arbitrumOne: ZERO_ADDRESS,
} as const;

export const DATA_LEASE_CONTRACTS = {
  arbitrumSepolia: "0xa3aab9773b8f354aadc2489281aa232b03cacd71",
  arbitrumOne: ZERO_ADDRESS,
} as const;

export type DataMarketChainId = keyof typeof DATA_PROVENANCE_CONTRACTS;

export const DATA_MARKET_RPC: Record<DataMarketChainId, string> = {
  arbitrumSepolia: "https://sepolia-rollup.arbitrum.io/rpc",
  arbitrumOne: "https://arb1.arbitrum.io/rpc",
};

export const DATA_MARKET_CHAIN_IDS: Record<DataMarketChainId, number> = {
  arbitrumSepolia: 421614,
  arbitrumOne: 42161,
};

export function getProvenanceAddress(chain: DataMarketChainId): string {
  return DATA_PROVENANCE_CONTRACTS[chain];
}

export function getLeaseAddress(chain: DataMarketChainId): string {
  return DATA_LEASE_CONTRACTS[chain];
}

export function isDataMarketReady(chain: DataMarketChainId): boolean {
  return (
    DATA_PROVENANCE_CONTRACTS[chain] !== ZERO_ADDRESS &&
    DATA_LEASE_CONTRACTS[chain] !== ZERO_ADDRESS
  );
}

/** ABI surface for the DataProvenance Stylus contract. */
export const DATA_PROVENANCE_ABI = [
  "function initialize(address owner)",
  "function owner() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function mintProvenance(bytes32 merkleRoot, bytes contentURI, bytes32 humanProof) returns (uint256)",
  "function creatorOf(uint256 tokenId) view returns (address)",
  "function merkleRootOf(uint256 tokenId) view returns (bytes32)",
  "function contentUriOf(uint256 tokenId) view returns (bytes)",
  "function humanProofOf(uint256 tokenId) view returns (bytes32)",
  "function mintedAt(uint256 tokenId) view returns (uint256)",
  "function creatorCount(address creator) view returns (uint256)",
  "function revoke(uint256 tokenId)",
  "event ProvenanceMinted(uint256 indexed tokenId, address indexed creator, bytes32 indexed merkleRoot, bytes32 humanProof, bytes contentURI, uint256 mintedAt)",
  "event ProvenanceRevoked(uint256 indexed tokenId, address indexed by)",
] as const;

/** ABI surface for the DataLease Stylus contract. */
export const DATA_LEASE_ABI = [
  "function initialize(address owner, address feeRecipient, uint256 protocolFeeBps)",
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function protocolFeeBps() view returns (uint256)",
  "function totalListings() view returns (uint256)",
  "function totalLeases() view returns (uint256)",
  "function createListing(uint256 tokenId, uint256 priceWei, uint256 durationSecs, bytes32 accConditionsHash) returns (uint256)",
  "function deactivateListing(uint256 listingId)",
  "function updateListingPrice(uint256 listingId, uint256 newPriceWei)",
  "function purchaseLease(uint256 listingId) payable returns (uint256)",
  "function listingCreator(uint256 listingId) view returns (address)",
  "function listingTokenId(uint256 listingId) view returns (uint256)",
  "function listingPriceWei(uint256 listingId) view returns (uint256)",
  "function listingDurationSecs(uint256 listingId) view returns (uint256)",
  "function listingAccHash(uint256 listingId) view returns (bytes32)",
  "function listingActive(uint256 listingId) view returns (bool)",
  "function leaseLessee(uint256 leaseId) view returns (address)",
  "function leaseExpiresAt(uint256 leaseId) view returns (uint256)",
  "function leasePaidWei(uint256 leaseId) view returns (uint256)",
  "function leaseListingId(uint256 leaseId) view returns (uint256)",
  "function hasActiveLease(uint256 listingId, address lessee) view returns (bool)",
  "function creatorEarnings(address creator) view returns (uint256)",
  "function setProtocolFeeBps(uint256 newBps)",
  "function setFeeRecipient(address newRecipient)",
  "event ListingCreated(uint256 indexed listingId, address indexed creator, uint256 indexed tokenId, uint256 priceWei, uint256 durationSecs, bytes32 accConditionsHash)",
  "event ListingDeactivated(uint256 indexed listingId, address indexed by)",
  "event ListingPriceUpdated(uint256 indexed listingId, uint256 newPriceWei)",
  "event LeaseGranted(uint256 indexed leaseId, uint256 indexed listingId, address indexed lessee, uint256 tokenId, uint256 paidWei, uint256 expiresAt, bytes32 accConditionsHash)",
  "event CreatorPaid(address indexed creator, uint256 indexed listingId, uint256 amount)",
  "event ProtocolFeeUpdated(uint256 newBps)",
  "event FeeRecipientUpdated(address newRecipient)",
] as const;
