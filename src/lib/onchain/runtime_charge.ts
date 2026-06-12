/**
 * LRA glue — bind LR12's runtime micro-charge hook (`ChargeFn`) to the on-chain
 * x402 / RevenueSplitter settlement rail.
 *
 * `invokeAndMeter` (runtime_metering.ts) calls an optional `charge()` after a
 * successful invocation. This factory produces that `charge()` from a signed
 * x402 payment: it settles `transferWithAuthorization` → RevenueSplitter's
 * 80/10/10 `distribute`, then reports the settled amount + payer so metering can
 * mirror it into the earnings ledger.
 *
 * `settle` is injectable so callers can unit-test the metering path without a
 * wallet or a live chain.
 */

import type { ethers } from "ethers";

import { settlePayment } from "@/lib/x402/server";
import type { PaymentPayload, PaymentRequirements } from "@/lib/x402/types";
import type { ChargeFn } from "@/lib/onchain/runtime_metering";

export interface X402RuntimeChargeInput {
  /** Wallet that pays gas + owns the RevenueSplitter (calls distribute). */
  facilitator: ethers.Wallet;
  /** The renter's signed x402 payment authorization. */
  payment: PaymentPayload;
  /** Requirements the payment was signed against. */
  requirements: PaymentRequirements;
  /** Creator address receiving the 80% share. */
  creator: string;
}

export interface X402RuntimeChargeDeps {
  /** Override the settlement implementation (defaults to x402 `settlePayment`). */
  settle?: typeof settlePayment;
}

/**
 * Build a `ChargeFn` that settles a signed x402 payment on each invocation.
 * Throws when settlement fails so metering logs the charge error (best-effort —
 * `invokeAndMeter` never lets a charge failure discard runtime output).
 */
export function createX402RuntimeCharge(
  input: X402RuntimeChargeInput,
  deps: X402RuntimeChargeDeps = {},
): ChargeFn {
  const settle = deps.settle ?? settlePayment;
  return async () => {
    const result = await settle({
      facilitator: input.facilitator,
      payment: input.payment,
      requirements: input.requirements,
      creator: input.creator,
    });
    if (!result.success) {
      throw new Error(`x402 runtime charge failed: ${result.error ?? "settlement rejected"}`);
    }
    return {
      // Prefer the distribute() hash (funds reached the creator); fall back to
      // the transfer hash when distribute was deferred (funds held in splitter).
      txHash: result.distributeTxHash ?? result.txHash ?? "",
      amountUsdc: result.amount,
      renterAddress: result.payer,
    };
  };
}
