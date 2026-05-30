/**
 * Thin ethers wrapper around the OptimisticStaking Stylus contract.
 *
 * Used by `src/ipc/handlers/optimistic_staking_handlers.ts`. Writes require a
 * signing `Wallet`; reads only need a provider. The contract verifies a RAW
 * ECDSA signature over the 32-byte digest, so `submitAttestation` splits the
 * 65-byte signature into fixed (r, s, v) components at this boundary.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  OPTIMISTIC_STAKING_ABI,
  OPTIMISTIC_STAKING_RPC,
  type OptimisticStakingChainId,
  getOptimisticStakingAddress,
  isOptimisticStakingReady,
} from "@/config/optimistic_staking";

const logger = log.scope("optimistic_staking_client");

// Arbitrum Sepolia base fee floats low; these overrides keep txs cheap.
const TX_OVERRIDES = {
  maxFeePerGas: 200_000_000n,
  maxPriorityFeePerGas: 100_000n,
};

function requireReady(chain: OptimisticStakingChainId): void {
  if (!isOptimisticStakingReady(chain)) {
    throw new Error(
      `OptimisticStaking not deployed on ${chain} — fill the address in src/config/optimistic_staking.ts`,
    );
  }
}

export function makeProvider(chain: OptimisticStakingChainId): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(OPTIMISTIC_STAKING_RPC[chain]);
}

function stakingContract(
  chain: OptimisticStakingChainId,
  signerOrProvider?: ethers.Signer | ethers.Provider,
): ethers.Contract {
  requireReady(chain);
  return new ethers.Contract(
    getOptimisticStakingAddress(chain),
    OPTIMISTIC_STAKING_ABI as unknown as ethers.InterfaceAbi,
    signerOrProvider ?? makeProvider(chain),
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface TxResult {
  txHash: string;
  blockNumber: number;
}

async function send(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
): Promise<TxResult> {
  const tx: ethers.TransactionResponse = await contract[method](...args, TX_OVERRIDES);
  const receipt = await tx.wait();
  logger.info(`${method} tx=${tx.hash} block=${receipt?.blockNumber ?? 0}`);
  return { txHash: tx.hash, blockNumber: receipt?.blockNumber ?? 0 };
}

export async function deposit(
  wallet: ethers.Wallet,
  input: { chain: OptimisticStakingChainId; amount: bigint },
): Promise<TxResult> {
  if (input.amount <= 0n) throw new Error("amount must be positive");
  return send(stakingContract(input.chain, wallet), "deposit", [input.amount]);
}

export async function withdraw(
  wallet: ethers.Wallet,
  input: { chain: OptimisticStakingChainId; amount: bigint },
): Promise<TxResult> {
  if (input.amount <= 0n) throw new Error("amount must be positive");
  return send(stakingContract(input.chain, wallet), "withdraw", [input.amount]);
}

export async function submitAttestation(
  wallet: ethers.Wallet,
  input: {
    chain: OptimisticStakingChainId;
    digest: string;
    signer: string;
    score: bigint;
    bond: bigint;
    signature: string;
  },
): Promise<TxResult> {
  if (!ethers.isHexString(input.digest, 32)) {
    throw new Error("digest must be a 32-byte hex string");
  }
  if (!ethers.isAddress(input.signer)) {
    throw new Error("signer must be a valid address");
  }
  if (input.score > 100n) throw new Error("score must be in [0,100]");
  if (input.bond <= 0n) throw new Error("bond must be positive");

  const sig = ethers.Signature.from(input.signature);
  return send(stakingContract(input.chain, wallet), "submitAttestation", [
    input.digest,
    input.signer,
    input.score,
    input.bond,
    sig.r,
    sig.s,
    sig.v,
  ]);
}

export async function challengeSignature(
  wallet: ethers.Wallet,
  input: { chain: OptimisticStakingChainId; digest: string },
): Promise<TxResult> {
  return send(stakingContract(input.chain, wallet), "challengeSignature", [input.digest]);
}

export async function openDispute(
  wallet: ethers.Wallet,
  input: { chain: OptimisticStakingChainId; digest: string },
): Promise<TxResult> {
  return send(stakingContract(input.chain, wallet), "openDispute", [input.digest]);
}

export async function resolveDispute(
  wallet: ethers.Wallet,
  input: { chain: OptimisticStakingChainId; digest: string; validatorSlashed: boolean },
): Promise<TxResult> {
  return send(stakingContract(input.chain, wallet), "resolveDispute", [
    input.digest,
    input.validatorSlashed,
  ]);
}

export async function finalize(
  wallet: ethers.Wallet,
  input: { chain: OptimisticStakingChainId; digest: string },
): Promise<TxResult> {
  return send(stakingContract(input.chain, wallet), "finalize", [input.digest]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AttestationView {
  submitter: string;
  signer: string;
  score: string;
  bond: string;
  deadline: string;
  status: number;
}

export async function getAttestation(
  chain: OptimisticStakingChainId,
  digest: string,
): Promise<AttestationView> {
  const r = await stakingContract(chain).getAttestation(digest);
  return {
    submitter: r[0] as string,
    signer: r[1] as string,
    score: (r[2] as bigint).toString(),
    bond: (r[3] as bigint).toString(),
    deadline: (r[4] as bigint).toString(),
    status: Number(r[5] as bigint),
  };
}

export interface StakeView {
  stake: string;
  locked: string;
}

export async function stakeOf(
  chain: OptimisticStakingChainId,
  validator: string,
): Promise<StakeView> {
  const r = await stakingContract(chain).stakeOf(validator);
  return { stake: (r[0] as bigint).toString(), locked: (r[1] as bigint).toString() };
}

export interface StakingConfigView {
  owner: string;
  arbiter: string;
  stakeToken: string;
  minStake: string;
  challengeWindow: string;
}

export async function getConfig(
  chain: OptimisticStakingChainId,
): Promise<StakingConfigView> {
  const r = await stakingContract(chain).getConfig();
  return {
    owner: r[0] as string,
    arbiter: r[1] as string,
    stakeToken: r[2] as string,
    minStake: (r[3] as bigint).toString(),
    challengeWindow: (r[4] as bigint).toString(),
  };
}
