/**
 * Verified-inference orchestrator.
 *
 * Ties the attestation layer into the on-chain pipeline:
 *
 *   inference {input, output, modelId}
 *        │  attest (local | optimistic | lit | nitro)
 *        ▼
 *   AttestationQuote (digest = keccak(inputHash‖outputHash‖modelId))
 *        │  best-effort anchor to Celestia (proofs namespace)
 *        ▼
 *   ValidationRegistry.validationRequest + validationResponse
 *        │
 *        ▼
 *   VerifiedInferenceRecord  → caller can proceed to EditionController mint
 *
 * Everything beyond `attest` is best-effort and gated: with mode "local" no
 * chain writes happen at all (zero cost), so the full flow runs in demos
 * without spending. Switching JOY_TEE_MODE flips on real attestation + writes.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  resolveTeeMode,
  isTeeReady,
  type TeeMode,
} from "@/config/tee";
import {
  makeAttestationProvider,
  type AttestationQuote,
  type InferenceJob,
} from "./attestation_provider";
import { validationRequest, validationResponse } from "@/lib/onchain/erc8004_client";
import type { Erc8004ChainId } from "@/config/erc8004";

const logger = log.scope("tee_orchestrator");

export interface VerifiedInferenceInput extends InferenceJob {
  chain: Erc8004ChainId;
  /** Score in [0,100] to record on the ValidationRegistry. Default 100. */
  score?: number;
  /** When false, skip the on-chain ValidationRegistry write. Default true. */
  writeOnChain?: boolean;
  /** When true, anchor the quote to Celestia (best-effort). Default false. */
  anchorCelestia?: boolean;
}

export interface VerifiedInferenceRecord {
  mode: TeeMode;
  quote: AttestationQuote;
  /** ValidationRegistry write outcome (null when skipped / local mode). */
  validation: {
    requestTxHash: string;
    responseTxHash: string;
    score: number;
  } | null;
  /** Celestia anchor outcome (null when not requested or unavailable). */
  celestia: { height: number; commitment: string } | null;
}

/**
 * Run the verified-inference flow against a precomputed {input, output}.
 *
 * The heavy model inference is performed by the caller (e.g. the local
 * trustless inference service); this function attests the result and records
 * it on-chain. The optimistic provider signs with `wallet`; other providers
 * are self-contained or gated on env config.
 */
export async function runVerifiedInference(
  wallet: ethers.Wallet | undefined,
  input: VerifiedInferenceInput,
): Promise<VerifiedInferenceRecord> {
  const mode = resolveTeeMode();
  if (!isTeeReady(mode)) {
    throw new Error(`TEE mode "${mode}" is selected but not configured/ready`);
  }
  if (!input.modelId) throw new Error("modelId is required");
  if (input.input == null) throw new Error("input is required");
  if (input.output == null) throw new Error("output is required");

  const provider = makeAttestationProvider(mode, wallet);
  const quote = await provider.attest({
    modelId: input.modelId,
    input: input.input,
    output: input.output,
    serverAgentId: input.serverAgentId,
  });

  // --- best-effort Celestia anchor -------------------------------------
  let celestia: VerifiedInferenceRecord["celestia"] = null;
  if (input.anchorCelestia) {
    try {
      const { celestiaBlobService } = await import("@/lib/celestia_blob_service");
      const sub = await celestiaBlobService.submitJSON(quote, {
        namespaceKey: "proofs",
        label: `tee-attestation:${quote.digest}`,
        dataType: "tee-attestation",
      });
      celestia = { height: sub.height, commitment: sub.commitment };
      logger.info(`anchored attestation to Celestia height=${sub.height}`);
    } catch (err) {
      logger.warn(`Celestia anchor failed (best-effort): ${(err as Error).message}`);
    }
  }

  // --- ValidationRegistry write ----------------------------------------
  // Local mode produces no verifiable signature, so it never writes on-chain.
  const writeOnChain = input.writeOnChain !== false && mode !== "local";
  let validation: VerifiedInferenceRecord["validation"] = null;
  if (writeOnChain) {
    if (!wallet) {
      throw new Error("on-chain validation write requires a signing wallet");
    }
    const score = clampScore(input.score ?? 100);
    const serverAgentId = input.serverAgentId ?? "0";
    const req = await validationRequest(wallet, {
      chain: input.chain,
      validator: quote.signer === ethers.ZeroAddress ? wallet.address : quote.signer,
      serverAgentId,
      dataHash: quote.digest,
    });
    const resp = await validationResponse(wallet, {
      chain: input.chain,
      dataHash: quote.digest,
      response: score,
    });
    validation = {
      requestTxHash: req.txHash,
      responseTxHash: resp.txHash,
      score,
    };
    logger.info(`recorded validation for digest=${quote.digest} score=${score}`);
  }

  return { mode, quote, validation, celestia };
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}
