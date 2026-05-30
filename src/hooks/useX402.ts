/**
 * TanStack Query hooks for the X402 pay-per-prompt rail — challenge creation,
 * payment signing, verification, settlement and creator earnings.
 * Backed by the IPC channels registered in
 *   src/ipc/handlers/x402_handlers.ts
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  IpcClient,
  type X402ChainId,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402PurchaseResult,
  type X402SettleResult,
  type X402VerifyResult,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function useX402Status(chain?: X402ChainId) {
  return useQuery<{ chain: X402ChainId; ready: boolean }>({
    queryKey: ["x402", "status", chain ?? "default"],
    queryFn: () => ipc.x402Status({ chain }),
  });
}

// ---------------------------------------------------------------------------
// Creator earnings (read)
// ---------------------------------------------------------------------------

export function useCreatorEarnings(creator: string | undefined, chain?: X402ChainId) {
  return useQuery<{ token: string; creator: string; earnings: string }>({
    queryKey: ["x402", "creator-earnings", chain ?? "default", creator],
    queryFn: () => ipc.x402CreatorEarnings({ chain, creator: creator! }),
    enabled: Boolean(creator),
  });
}

// ---------------------------------------------------------------------------
// Challenge (build PaymentRequirements)
// ---------------------------------------------------------------------------

export function useCreateChallenge() {
  return useMutation<
    X402PaymentRequirements,
    Error,
    {
      chain?: X402ChainId;
      amountAtomic?: string;
      amountUsdc?: string;
      resource: string;
      description: string;
      mimeType?: string;
      maxTimeoutSeconds?: number;
    }
  >({
    mutationFn: (args) => ipc.x402CreateChallenge(args),
    onError: (err) => toast.error(`Failed to create x402 challenge: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// Payment (sign EIP-3009 authorization)
// ---------------------------------------------------------------------------

export function useCreatePayment() {
  return useMutation<
    { payload: X402PaymentPayload; header: string; payer: string },
    Error,
    { chain?: X402ChainId; requirements: X402PaymentRequirements }
  >({
    mutationFn: (args) => ipc.x402CreatePayment(args),
    onError: (err) => toast.error(`Failed to sign payment: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// Verify (no settlement)
// ---------------------------------------------------------------------------

export function useVerifyPayment() {
  return useMutation<
    X402VerifyResult,
    Error,
    { payment: X402PaymentPayload; requirements: X402PaymentRequirements }
  >({
    mutationFn: (args) => ipc.x402VerifyPayment(args),
    onError: (err) => toast.error(`Payment verification failed: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// Settle (transferWithAuthorization + 80/10/10 distribute)
// ---------------------------------------------------------------------------

export function useSettlePayment() {
  const qc = useQueryClient();
  return useMutation<
    X402SettleResult,
    Error,
    {
      chain?: X402ChainId;
      payment: X402PaymentPayload;
      requirements: X402PaymentRequirements;
      creator: string;
    }
  >({
    mutationFn: (args) => ipc.x402Settle(args),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["x402", "creator-earnings"] });
      toast.success("Payment settled");
      void vars;
    },
    onError: (err) => toast.error(`Settlement failed: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// Purchase (end-to-end pay-per-mint of an EditionController drop)
// ---------------------------------------------------------------------------

export function usePurchaseEdition() {
  const qc = useQueryClient();
  return useMutation<
    X402PurchaseResult,
    Error,
    { chain?: X402ChainId; dropId: string }
  >({
    mutationFn: (args) => ipc.x402PurchaseEdition(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["x402", "creator-earnings"] });
      qc.invalidateQueries({ queryKey: ["glue", "drop"] });
      qc.invalidateQueries({ queryKey: ["glue", "edition-balance"] });
      toast.success("Edition minted");
    },
    onError: (err) => toast.error(`Purchase failed: ${err.message}`),
  });
}
