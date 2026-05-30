/**
 * OptimisticStaking IPC handlers.
 *
 * Wraps the bonded-attestation Stylus contract (deposit / withdraw / submit /
 * challenge / dispute / finalize + reads). Writes load the active chain key
 * from jcnKeyManager and sign through the ethers client.
 *
 * Channels registered here MUST also be added to:
 *   - src/ipc/ipc_host.ts (registerOptimisticStakingHandlers)
 *   - src/preload.ts allowlist
 *   - src/ipc/ipc_client.ts (renderer-side methods)
 */

import { ipcMain } from "electron";
import { ethers } from "ethers";
import log from "electron-log";

import { jcnKeyManager } from "@/lib/jcn_key_manager";
import {
  DEFAULT_OPTIMISTIC_STAKING_CHAIN,
  OPTIMISTIC_STAKING_RPC,
  type OptimisticStakingChainId,
} from "@/config/optimistic_staking";
import {
  challengeSignature,
  deposit,
  finalize,
  getAttestation,
  getConfig,
  openDispute,
  resolveDispute,
  stakeOf,
  submitAttestation,
  withdraw,
  type AttestationView,
  type StakeView,
  type StakingConfigView,
  type TxResult,
} from "@/lib/onchain/optimistic_staking_client";

const logger = log.scope("optimistic_staking_handlers");

const SUPPORTED_CHAINS: readonly OptimisticStakingChainId[] = [
  "arbitrumSepolia",
  "arbitrumOne",
];

function resolveChain(value: unknown): OptimisticStakingChainId {
  if (typeof value === "string" && (SUPPORTED_CHAINS as readonly string[]).includes(value)) {
    return value as OptimisticStakingChainId;
  }
  if (value == null) return DEFAULT_OPTIMISTIC_STAKING_CHAIN;
  throw new Error(`chain must be one of ${SUPPORTED_CHAINS.join(", ")}, got ${String(value)}`);
}

async function loadWallet(chain: OptimisticStakingChainId): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((k) => k.active && k.algorithm === "secp256k1");
  if (!active) {
    throw new Error("no active chain (secp256k1) key in jcnKeyManager — import one in Settings");
  }
  const pk = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!pk) throw new Error("active chain key has no private material");
  const provider = new ethers.JsonRpcProvider(OPTIMISTIC_STAKING_RPC[chain]);
  const hex = pk.toString("hex");
  return new ethers.Wallet(hex.startsWith("0x") ? hex : `0x${hex}`, provider);
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value);
    } catch {
      throw new Error(`${field} must be an integer, got ${value}`);
    }
  }
  throw new Error(`${field} is required and must be an integer`);
}

export function registerOptimisticStakingHandlers(): void {
  // --- reads ------------------------------------------------------------
  ipcMain.handle(
    "optimistic-staking:get-config",
    async (_e, params: { chain?: string }): Promise<StakingConfigView> => {
      return getConfig(resolveChain(params?.chain));
    },
  );

  ipcMain.handle(
    "optimistic-staking:get-attestation",
    async (_e, params: { chain?: string; digest: string }): Promise<AttestationView> => {
      if (!params?.digest) throw new Error("digest is required");
      return getAttestation(resolveChain(params.chain), params.digest);
    },
  );

  ipcMain.handle(
    "optimistic-staking:stake-of",
    async (_e, params: { chain?: string; validator: string }): Promise<StakeView> => {
      if (!params?.validator) throw new Error("validator is required");
      return stakeOf(resolveChain(params.chain), params.validator);
    },
  );

  // --- writes -----------------------------------------------------------
  ipcMain.handle(
    "optimistic-staking:deposit",
    async (_e, params: { chain?: string; amount: string }): Promise<TxResult> => {
      const chain = resolveChain(params?.chain);
      const wallet = await loadWallet(chain);
      logger.info(`deposit signer=${wallet.address}`);
      return deposit(wallet, { chain, amount: toBigInt(params?.amount, "amount") });
    },
  );

  ipcMain.handle(
    "optimistic-staking:withdraw",
    async (_e, params: { chain?: string; amount: string }): Promise<TxResult> => {
      const chain = resolveChain(params?.chain);
      const wallet = await loadWallet(chain);
      logger.info(`withdraw signer=${wallet.address}`);
      return withdraw(wallet, { chain, amount: toBigInt(params?.amount, "amount") });
    },
  );

  ipcMain.handle(
    "optimistic-staking:submit-attestation",
    async (
      _e,
      params: {
        chain?: string;
        digest: string;
        signer: string;
        score: string;
        bond: string;
        signature: string;
      },
    ): Promise<TxResult> => {
      if (!params?.digest) throw new Error("digest is required");
      if (!params?.signer) throw new Error("signer is required");
      if (!params?.signature) throw new Error("signature is required");
      const chain = resolveChain(params.chain);
      const wallet = await loadWallet(chain);
      logger.info(`submitAttestation digest=${params.digest} signer=${params.signer}`);
      return submitAttestation(wallet, {
        chain,
        digest: params.digest,
        signer: params.signer,
        score: toBigInt(params.score, "score"),
        bond: toBigInt(params.bond, "bond"),
        signature: params.signature,
      });
    },
  );

  ipcMain.handle(
    "optimistic-staking:challenge-signature",
    async (_e, params: { chain?: string; digest: string }): Promise<TxResult> => {
      if (!params?.digest) throw new Error("digest is required");
      const chain = resolveChain(params.chain);
      const wallet = await loadWallet(chain);
      logger.info(`challengeSignature digest=${params.digest} signer=${wallet.address}`);
      return challengeSignature(wallet, { chain, digest: params.digest });
    },
  );

  ipcMain.handle(
    "optimistic-staking:open-dispute",
    async (_e, params: { chain?: string; digest: string }): Promise<TxResult> => {
      if (!params?.digest) throw new Error("digest is required");
      const chain = resolveChain(params.chain);
      const wallet = await loadWallet(chain);
      logger.info(`openDispute digest=${params.digest} signer=${wallet.address}`);
      return openDispute(wallet, { chain, digest: params.digest });
    },
  );

  ipcMain.handle(
    "optimistic-staking:resolve-dispute",
    async (
      _e,
      params: { chain?: string; digest: string; validatorSlashed: boolean },
    ): Promise<TxResult> => {
      if (!params?.digest) throw new Error("digest is required");
      if (typeof params.validatorSlashed !== "boolean") {
        throw new Error("validatorSlashed must be a boolean");
      }
      const chain = resolveChain(params.chain);
      const wallet = await loadWallet(chain);
      logger.info(`resolveDispute digest=${params.digest} slashed=${params.validatorSlashed}`);
      return resolveDispute(wallet, {
        chain,
        digest: params.digest,
        validatorSlashed: params.validatorSlashed,
      });
    },
  );

  ipcMain.handle(
    "optimistic-staking:finalize",
    async (_e, params: { chain?: string; digest: string }): Promise<TxResult> => {
      if (!params?.digest) throw new Error("digest is required");
      const chain = resolveChain(params.chain);
      const wallet = await loadWallet(chain);
      logger.info(`finalize digest=${params.digest} signer=${wallet.address}`);
      return finalize(wallet, { chain, digest: params.digest });
    },
  );
}
