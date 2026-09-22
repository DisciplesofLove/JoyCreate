/**
 * LR3 — Post-purchase reputation.
 *
 * After a settled x402 purchase + mint, record verifiable feedback against the
 * store's serving agent so the ReputationRegistry's `averageScore` reflects real
 * transactions (closing gap G3 — reputation was read but never submitted).
 *
 * The ReputationRegistry is two-sided: the serving agent must `acceptFeedback`
 * before a client's `submitFeedback` is counted. In the desktop single-wallet
 * flow the buyer wallet may also own the serving agent (self-serve / dev), in
 * which case we auto-accept then submit. Otherwise feedback is skipped with a
 * reason — the seller's instance accepts on its side. This whole flow is
 * best-effort: a purchase is already settled before it runs and must never fail
 * because of a reputation hiccup.
 */

import { ethers } from "ethers";
import log from "electron-log";

import type { Erc8004ChainId } from "@/config/erc8004";
import {
  acceptFeedback,
  getAgent,
  isFeedbackAuthorized,
  resolveByAddress,
  submitFeedback,
} from "@/lib/onchain/erc8004_client";

const logger = log.scope("reputation");

/** Default purchase feedback score (0–100). A completed purchase is positive. */
export const DEFAULT_PURCHASE_SCORE = 100;

/** Current purchase-receipt schema version (the pinned `bytes` feedback payload). */
export const FEEDBACK_RECEIPT_VERSION = "joy-feedback/1.0";

export interface FeedbackReceiptInput {
  dropId: string;
  tokenId: string;
  buyer: string;
  creator: string;
  amountAtomic: string;
  settlementTxHash?: string;
  mintTxHash?: string;
  score?: number;
}

export interface FeedbackReceipt {
  schema: string;
  dropId: string;
  tokenId: string;
  buyer: string;
  creator: string;
  amountAtomic: string;
  settlementTxHash: string | null;
  mintTxHash: string | null;
  score: number;
  issuedAt: string;
}

/**
 * Build the receipt object that backs a feedback submission. Pure — pin it and
 * pass the resulting `ipfs://` URI as `feedbackUri` to `submitPurchaseFeedback`.
 */
export function buildFeedbackReceipt(input: FeedbackReceiptInput): FeedbackReceipt {
  return {
    schema: FEEDBACK_RECEIPT_VERSION,
    dropId: input.dropId,
    tokenId: input.tokenId,
    buyer: input.buyer,
    creator: input.creator,
    amountAtomic: input.amountAtomic,
    settlementTxHash: input.settlementTxHash ?? null,
    mintTxHash: input.mintTxHash ?? null,
    score: clampScore(input.score ?? DEFAULT_PURCHASE_SCORE),
    issuedAt: new Date().toISOString(),
  };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return DEFAULT_PURCHASE_SCORE;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface PurchaseFeedbackInput {
  chain: Erc8004ChainId;
  /** The store's serving agent id (serverId). */
  serverId: string;
  /** The buyer's address (resolved to a clientId via the IdentityRegistry). */
  buyer: string;
  /** Feedback score in [0, 100]. Defaults to {@link DEFAULT_PURCHASE_SCORE}. */
  score?: number;
  /** Optional ipfs:// pointer to a pinned {@link FeedbackReceipt}. */
  feedbackUri?: string;
}

export interface PurchaseFeedbackResult {
  submitted: boolean;
  skipped: boolean;
  reason?: string;
  clientId: string;
  serverId: string;
  score: number;
  txHash?: string;
  acceptTxHash?: string;
}

/**
 * Submit reputation feedback for a settled purchase. Resolves the buyer's
 * clientId, ensures the serving agent has authorized feedback (auto-accepting
 * when this wallet owns the serving agent), then submits. Never throws on a
 * benign skip; only genuine on-chain failures propagate.
 */
export async function submitPurchaseFeedback(
  wallet: ethers.Wallet,
  input: PurchaseFeedbackInput,
): Promise<PurchaseFeedbackResult> {
  const { chain, serverId, buyer } = input;
  const score = clampScore(input.score ?? DEFAULT_PURCHASE_SCORE);
  const base = { submitted: false, skipped: true, clientId: "0", serverId, score };

  if (serverId === "0") {
    return { ...base, reason: "store has no serving agent identity" };
  }

  const clientId = await resolveByAddress(chain, buyer);
  if (clientId === "0") {
    return { ...base, reason: "buyer has no agent identity (clientId)" };
  }
  if (clientId === serverId) {
    return { ...base, clientId, reason: "buyer is the serving agent (self-feedback)" };
  }

  let acceptTxHash: string | undefined;
  let authorized = await isFeedbackAuthorized(chain, clientId, serverId);
  if (!authorized) {
    // Auto-accept only when this wallet owns the serving agent (self-serve/dev).
    let serverAddress: string | undefined;
    try {
      serverAddress = (await getAgent(chain, serverId)).agentAddress;
    } catch (err) {
      logger.warn(`serving agent ${serverId} lookup failed: ${err}`);
    }
    if (serverAddress && serverAddress.toLowerCase() === wallet.address.toLowerCase()) {
      const accept = await acceptFeedback(wallet, { chain, clientId, serverId });
      acceptTxHash = accept.txHash;
      authorized = true;
    } else {
      return {
        submitted: false,
        skipped: true,
        clientId,
        serverId,
        score,
        reason: "feedback not authorized by serving agent",
      };
    }
  }

  const result = await submitFeedback(wallet, {
    chain,
    clientId,
    serverId,
    score,
    feedbackUri: input.feedbackUri,
  });

  return {
    submitted: true,
    skipped: false,
    clientId,
    serverId,
    score,
    txHash: result.txHash,
    acceptTxHash,
  };
}
