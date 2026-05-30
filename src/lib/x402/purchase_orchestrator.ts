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
import { getDrop, grantProof, mintEdition } from "@/lib/onchain/glue_client";

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
}

/**
 * Purchase (pay-per-mint) a drop with X402 + the EditionController.
 *
 * @param wallet - the loaded wallet acting as payer, facilitator and buyer.
 */
export async function purchaseEdition(
  wallet: ethers.Wallet,
  input: { chain: X402ChainId; dropId: string },
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
  };
}
