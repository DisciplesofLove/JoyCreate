/**
 * End-to-end X402 purchase of an EditionController drop.
 *
 * Ties the pay-per-mint settlement rail to the on-chain mint:
 *   1. read the drop (price in USDC atomic units, creator, proof gating)
 *   2. build the 402 challenge for the drop price
 *   3. sign the EIP-3009 authorization (payer)
 *   4. settle: transferWithAuthorization → RevenueSplitter → 80/10/10 distribute
 *   5. grantProof(dropId, buyer) when the drop requires proof-of-use
 *   6. mint(dropId) → tokenId
 *   7. submitPurchaseFeedback → ReputationRegistry (best-effort, LR3)
 *
 * For the desktop single-wallet flow the payer, facilitator and buyer are the
 * same loaded wallet.
 */

import { ethers } from "ethers";
import log from "electron-log";

import { atomicToUsdc, type X402ChainId } from "@/config/x402";
import { createPayment } from "@/lib/x402/client";
import { createPaymentRequirements, settlePayment } from "@/lib/x402/server";
import type { SettleResult } from "@/lib/x402/types";
import {
  canSpend,
  getDrop,
  getStore,
  grantProof,
  isMandateValid,
  mintEdition,
  recordSpend,
} from "@/lib/onchain/glue_client";
import {
  submitPurchaseFeedback,
  type PurchaseFeedbackResult,
} from "@/lib/onchain/reputation";

const logger = log.scope("x402_purchase");

export interface PurchaseResult {
  dropId: string;
  creator: string;
  buyer: string;
  amountAtomic: string;
  settlement: SettleResult;
  proofTxHash?: string;
  tokenId: string;
  mintTxHash: string;
  blockNumber: number;
  /** Post-purchase reputation outcome (LR3). Best-effort; never blocks a mint. */
  feedback?: PurchaseFeedbackResult;
}

/**
 * Purchase (pay-per-mint) a drop with X402 + the EditionController.
 *
 * @param wallet - the loaded wallet acting as payer, facilitator and buyer.
 */
export async function purchaseEdition(
  wallet: ethers.Wallet,
  input: { chain: X402ChainId; dropId: string; feedbackScore?: number },
): Promise<PurchaseResult> {
  const { chain, dropId } = input;
  const drop = await getDrop(chain, dropId);
  if (!drop.active) throw new Error(`drop ${dropId} is not active`);
  if (drop.price === "0") throw new Error(`drop ${dropId} has no price set`);

  const buyer = wallet.address;
  logger.info(
    `purchasing drop ${dropId}: ${atomicToUsdc(drop.price)} USDC, creator ${drop.creator}`,
  );

  // 1. Build the 402 challenge for the drop price.
  const requirements = createPaymentRequirements({
    chain,
    amountAtomic: drop.price,
    resource: `drop:${dropId}`,
    description: `JOY edition mint for drop ${dropId}`,
  });

  // 2. Payer signs the EIP-3009 authorization.
  const { payload } = await createPayment(wallet, requirements);

  // 3. Settle: USDC → splitter → 80/10/10 to the creator.
  const settlement = await settlePayment({
    facilitator: wallet,
    payment: payload,
    requirements,
    creator: drop.creator,
  });
  if (!settlement.success) {
    throw new Error(settlement.error ?? "x402 settlement failed");
  }

  // 4. Grant proof-of-use when required, then mint.
  let proofTxHash: string | undefined;
  if (drop.requiresProof) {
    const proof = await grantProof(wallet, { chain, dropId, account: buyer });
    proofTxHash = proof.txHash;
  }

  const mint = await mintEdition(wallet, { chain, dropId });

  // 5. Record reputation feedback against the store's serving agent (LR3).
  //    Best-effort: the purchase is already settled, so a reputation failure
  //    must not surface as a purchase failure.
  let feedback: PurchaseFeedbackResult | undefined;
  try {
    const store = await getStore(chain, drop.storeId);
    feedback = await submitPurchaseFeedback(wallet, {
      chain,
      serverId: store.agentId,
      buyer,
      score: input.feedbackScore,
    });
    if (feedback.submitted) {
      logger.info(`reputation feedback submitted for store agent ${store.agentId}`);
    } else {
      logger.info(`reputation feedback skipped: ${feedback.reason}`);
    }
  } catch (err) {
    logger.warn(`reputation feedback failed (non-fatal): ${err}`);
  }

  return {
    dropId,
    creator: drop.creator,
    buyer,
    amountAtomic: drop.price,
    settlement,
    proofTxHash,
    tokenId: mint.tokenId,
    mintTxHash: mint.txHash,
    blockNumber: mint.blockNumber,
    feedback,
  };
}

export interface MandatePurchaseResult extends PurchaseResult {
  /** The AgentMandate the spend was charged against. */
  mandateId: string;
  /** The on-chain `recordSpend` tx that decremented the remaining allowance. */
  recordSpendTxHash: string;
}

/**
 * Purchase a drop **as an agent operating under an on-chain AgentMandate** (LR4).
 *
 * The mandate's spend cap is enforced on-chain: the allowance is checked with
 * `canSpend` *before* any USDC moves (so we never settle a payment we cannot
 * record), the x402 purchase runs, then `recordSpend` decrements the remaining
 * allowance. A mandate that is invalid/expired or a purchase that would exceed
 * the cap throws before settlement.
 *
 * @param wallet - the agent's wallet (payer + the mandated `agent`).
 */
export async function purchaseEditionWithMandate(
  wallet: ethers.Wallet,
  input: { chain: X402ChainId; dropId: string; mandateId: string; feedbackScore?: number },
): Promise<MandatePurchaseResult> {
  const { chain, dropId, mandateId } = input;

  const drop = await getDrop(chain, dropId);
  if (!drop.active) throw new Error(`drop ${dropId} is not active`);
  if (drop.price === "0") throw new Error(`drop ${dropId} has no price set`);

  // Pre-flight the mandate before any funds move.
  if (!(await isMandateValid(chain, mandateId))) {
    throw new Error(`mandate ${mandateId} is invalid or expired`);
  }
  if (!(await canSpend(chain, mandateId, drop.price))) {
    throw new Error(
      `mandate ${mandateId} cannot spend ${atomicToUsdc(drop.price)} USDC (over remaining cap)`,
    );
  }

  const purchase = await purchaseEdition(wallet, {
    chain,
    dropId,
    feedbackScore: input.feedbackScore,
  });

  // Charge the mandate on-chain (reverts if the cap was raced down meanwhile).
  const spend = await recordSpend(wallet, { chain, mandateId, amount: drop.price });
  logger.info(`recorded mandate ${mandateId} spend of ${atomicToUsdc(drop.price)} USDC`);

  return { ...purchase, mandateId, recordSpendTxHash: spend.txHash };
}
