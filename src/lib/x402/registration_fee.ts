/**
 * LR6 — Store-registration fee (G4).
 *
 * Charges a fixed USDC fee when a storefront is registered, settled over the
 * same x402 EIP-3009 rail as edition purchases and routed through the
 * RevenueSplitter (the StoreRegistry contract never holds funds). The fee is
 * paid by the registering wallet (payer = facilitator = the loaded wallet in the
 * desktop single-wallet flow) to the platform Treasury.
 *
 * This is a thin composition of the existing x402 primitives — no new on-chain
 * surface. Callers settle the fee *before* `registerStore`; a failed/short
 * payment throws so the registration is not performed for free.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  STORE_REGISTRATION_FEE_ATOMIC,
  atomicToUsdc,
  getRegistrationFeeRecipient,
  isRegistrationFeeReady,
  type X402ChainId,
} from "@/config/x402";
import { createPayment } from "@/lib/x402/client";
import { createPaymentRequirements, settlePayment } from "@/lib/x402/server";
import type { SettleResult } from "@/lib/x402/types";

const logger = log.scope("x402_registration_fee");

export interface RegistrationFeeResult {
  /** False when no fee was charged (chain not fee-ready). */
  charged: boolean;
  /** Atomic USDC amount charged (0 when skipped). */
  amountAtomic: string;
  /** Fee recipient (the platform Treasury), when charged. */
  recipient?: string;
  /** The x402 settlement result, when charged. */
  settlement?: SettleResult;
  /** Reason the fee was skipped, when not charged. */
  reason?: string;
}

/**
 * Settle the store-registration fee for `slug`. Returns `{ charged: false }`
 * (with a reason) when the chain has no fee configured, so callers can proceed
 * with a free registration on chains where the fee rail is not deployed. Throws
 * only on a genuine settlement failure (so a paid chain never registers for free).
 *
 * @param wallet - the registering wallet (payer + facilitator).
 */
export async function settleRegistrationFee(
  wallet: ethers.Wallet,
  input: { chain: X402ChainId; slug: string; amountAtomic?: string },
): Promise<RegistrationFeeResult> {
  const { chain, slug } = input;
  const amountAtomic = input.amountAtomic ?? STORE_REGISTRATION_FEE_ATOMIC;

  if (!isRegistrationFeeReady(chain)) {
    return {
      charged: false,
      amountAtomic: "0",
      reason: `registration fee not configured on ${chain}`,
    };
  }
  if (BigInt(amountAtomic) === 0n) {
    return { charged: false, amountAtomic: "0", reason: "registration fee is zero" };
  }

  const recipient = getRegistrationFeeRecipient(chain);
  const requirements = createPaymentRequirements({
    chain,
    amountAtomic,
    resource: `store-registration:${slug}`,
    description: `JOY store registration fee for "${slug}"`,
  });

  const { payload } = await createPayment(wallet, requirements);
  const settlement = await settlePayment({
    facilitator: wallet,
    payment: payload,
    requirements,
    creator: recipient,
  });
  if (!settlement.success) {
    throw new Error(settlement.error ?? "store-registration fee settlement failed");
  }

  logger.info(
    `registration fee of ${atomicToUsdc(amountAtomic)} USDC settled for store "${slug}"`,
  );
  return { charged: true, amountAtomic, recipient, settlement };
}
