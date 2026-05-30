/**
 * Thin ethers wrapper around the ERC-8004 Identity / Reputation / Validation
 * Stylus registries. Used by `src/ipc/handlers/erc8004_handlers.ts`.
 *
 * All writes require a signing `Wallet`; reads only need a provider.
 * Agent domains are stored on-chain as raw bytes (Stylus `sol_storage!` has
 * no `string` type), so this layer encodes/decodes UTF-8 at the boundary.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  ERC8004_RPC,
  IDENTITY_REGISTRY_ABI,
  REPUTATION_REGISTRY_ABI,
  VALIDATION_REGISTRY_ABI,
  type Erc8004ChainId,
  getIdentityRegistryAddress,
  getReputationRegistryAddress,
  getValidationRegistryAddress,
  isErc8004Ready,
} from "@/config/erc8004";

const logger = log.scope("erc8004_client");

// Arbitrum Sepolia base fee floats low; these overrides keep txs cheap.
const TX_OVERRIDES = {
  maxFeePerGas: 200_000_000n,
  maxPriorityFeePerGas: 100_000n,
};

function requireReady(chain: Erc8004ChainId): void {
  if (!isErc8004Ready(chain)) {
    throw new Error(
      `ERC-8004 registries not deployed on ${chain} — fill addresses in src/config/erc8004.ts`,
    );
  }
}

export function makeProvider(chain: Erc8004ChainId): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(ERC8004_RPC[chain]);
}

function identityContract(
  chain: Erc8004ChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  return new ethers.Contract(
    getIdentityRegistryAddress(chain),
    IDENTITY_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

function reputationContract(
  chain: Erc8004ChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  return new ethers.Contract(
    getReputationRegistryAddress(chain),
    REPUTATION_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

function validationContract(
  chain: Erc8004ChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  return new ethers.Contract(
    getValidationRegistryAddress(chain),
    VALIDATION_REGISTRY_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

// ---------------------------------------------------------------------------
// Identity Registry
// ---------------------------------------------------------------------------

export interface RegisterAgentInput {
  chain: Erc8004ChainId;
  /** Resolvable agent domain / URI. Stored as UTF-8 bytes on-chain. */
  agentDomain: string;
  /** Controlling address. MUST equal the signing wallet address. */
  agentAddress: string;
}

export interface RegisterAgentResult {
  agentId: string;
  txHash: string;
  blockNumber: number;
}

export async function registerAgent(
  wallet: ethers.Wallet,
  input: RegisterAgentInput,
): Promise<RegisterAgentResult> {
  if (!input.agentDomain) throw new Error("agentDomain is required");
  if (input.agentAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("agentAddress must equal the signing wallet address");
  }
  const contract = identityContract(input.chain, wallet);
  const domainBytes = ethers.toUtf8Bytes(input.agentDomain);
  const tx = await contract.newAgent(domainBytes, input.agentAddress, TX_OVERRIDES);
  logger.info("newAgent tx", tx.hash);
  const receipt = await tx.wait();
  if (!receipt) throw new Error("newAgent tx receipt was null");

  let agentId = "";
  const iface = contract.interface;
  for (const lg of receipt.logs ?? []) {
    try {
      const parsed = iface.parseLog({ topics: lg.topics as string[], data: lg.data });
      if (parsed?.name === "AgentRegistered") {
        agentId = (parsed.args.agentId as bigint).toString();
        break;
      }
    } catch {
      // not our event
    }
  }
  if (!agentId) throw new Error("AgentRegistered event not found in receipt");

  return { agentId, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

export interface UpdateAgentInput {
  chain: Erc8004ChainId;
  agentId: string;
  newDomain: string;
  newAddress: string;
}

export async function updateAgent(
  wallet: ethers.Wallet,
  input: UpdateAgentInput,
): Promise<{ txHash: string }> {
  if (!input.newDomain) throw new Error("newDomain is required");
  const contract = identityContract(input.chain, wallet);
  const domainBytes = ethers.toUtf8Bytes(input.newDomain);
  const tx = await contract.updateAgent(
    BigInt(input.agentId),
    domainBytes,
    input.newAddress,
    TX_OVERRIDES,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("updateAgent tx receipt was null");
  return { txHash: receipt.hash };
}

export interface AgentRecord {
  agentId: string;
  agentDomain: string;
  agentAddress: string;
}

export async function getAgent(
  chain: Erc8004ChainId,
  agentId: string,
): Promise<AgentRecord> {
  const contract = identityContract(chain);
  const [id, domainBytes, addr] = await contract.getAgent(BigInt(agentId));
  return {
    agentId: (id as bigint).toString(),
    agentDomain: ethers.toUtf8String(domainBytes as string),
    agentAddress: addr as string,
  };
}

export async function resolveByAddress(
  chain: Erc8004ChainId,
  agentAddress: string,
): Promise<string> {
  const contract = identityContract(chain);
  const id = (await contract.resolveByAddress(agentAddress)) as bigint;
  return id.toString();
}

export async function resolveByDomain(
  chain: Erc8004ChainId,
  agentDomain: string,
): Promise<string> {
  const contract = identityContract(chain);
  const domainHash = ethers.keccak256(ethers.toUtf8Bytes(agentDomain));
  const id = (await contract.resolveByDomainHash(domainHash)) as bigint;
  return id.toString();
}

export async function agentCount(chain: Erc8004ChainId): Promise<string> {
  const contract = identityContract(chain);
  const n = (await contract.agentCount()) as bigint;
  return n.toString();
}

// ---------------------------------------------------------------------------
// Reputation Registry
// ---------------------------------------------------------------------------

export async function acceptFeedback(
  wallet: ethers.Wallet,
  input: { chain: Erc8004ChainId; clientId: string; serverId: string },
): Promise<{ txHash: string }> {
  const contract = reputationContract(input.chain, wallet);
  const tx = await contract.acceptFeedback(
    BigInt(input.clientId),
    BigInt(input.serverId),
    TX_OVERRIDES,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("acceptFeedback tx receipt was null");
  return { txHash: receipt.hash };
}

export async function submitFeedback(
  wallet: ethers.Wallet,
  input: {
    chain: Erc8004ChainId;
    clientId: string;
    serverId: string;
    score: number;
    feedbackUri?: string;
  },
): Promise<{ txHash: string }> {
  if (input.score < 0 || input.score > 100) {
    throw new Error("score must be in [0, 100]");
  }
  const contract = reputationContract(input.chain, wallet);
  const uriBytes = ethers.toUtf8Bytes(input.feedbackUri ?? "");
  const tx = await contract.submitFeedback(
    BigInt(input.clientId),
    BigInt(input.serverId),
    BigInt(input.score),
    uriBytes,
    TX_OVERRIDES,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("submitFeedback tx receipt was null");
  return { txHash: receipt.hash };
}

export async function isFeedbackAuthorized(
  chain: Erc8004ChainId,
  clientId: string,
  serverId: string,
): Promise<boolean> {
  const contract = reputationContract(chain);
  return (await contract.isAuthorized(BigInt(clientId), BigInt(serverId))) as boolean;
}

export interface ReputationScore {
  count: string;
  sum: string;
  average: number;
}

export async function getReputationScore(
  chain: Erc8004ChainId,
  serverId: string,
): Promise<ReputationScore> {
  const contract = reputationContract(chain);
  const [count, sum] = await contract.getScore(BigInt(serverId));
  const avg = (await contract.averageScore(BigInt(serverId))) as bigint;
  return {
    count: (count as bigint).toString(),
    sum: (sum as bigint).toString(),
    average: Number(avg),
  };
}

// ---------------------------------------------------------------------------
// Validation Registry
// ---------------------------------------------------------------------------

export async function validationRequest(
  wallet: ethers.Wallet,
  input: {
    chain: Erc8004ChainId;
    validator: string;
    serverAgentId: string;
    dataHash: string;
  },
): Promise<{ txHash: string }> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.dataHash)) {
    throw new Error("dataHash must be a 0x-prefixed 32-byte hex string");
  }
  const contract = validationContract(input.chain, wallet);
  const tx = await contract.validationRequest(
    input.validator,
    BigInt(input.serverAgentId),
    input.dataHash,
    TX_OVERRIDES,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("validationRequest tx receipt was null");
  return { txHash: receipt.hash };
}

export async function validationResponse(
  wallet: ethers.Wallet,
  input: { chain: Erc8004ChainId; dataHash: string; response: number },
): Promise<{ txHash: string }> {
  if (input.response < 0 || input.response > 100) {
    throw new Error("response must be in [0, 100]");
  }
  const contract = validationContract(input.chain, wallet);
  const tx = await contract.validationResponse(
    input.dataHash,
    BigInt(input.response),
    TX_OVERRIDES,
  );
  const receipt = await tx.wait();
  if (!receipt) throw new Error("validationResponse tx receipt was null");
  return { txHash: receipt.hash };
}

export interface ValidationRequestRecord {
  validator: string;
  serverAgentId: string;
  exists: boolean;
}

export async function getValidationRequest(
  chain: Erc8004ChainId,
  dataHash: string,
): Promise<ValidationRequestRecord> {
  const contract = validationContract(chain);
  const [validator, serverAgentId, exists] = await contract.getRequest(dataHash);
  return {
    validator: validator as string,
    serverAgentId: (serverAgentId as bigint).toString(),
    exists: exists as boolean,
  };
}

export interface ValidationResponseRecord {
  responded: boolean;
  score: number;
}

export async function getValidationResponse(
  chain: Erc8004ChainId,
  dataHash: string,
): Promise<ValidationResponseRecord> {
  const contract = validationContract(chain);
  const [responded, score] = await contract.getResponse(dataHash);
  return {
    responded: responded as boolean,
    score: Number(score as bigint),
  };
}
