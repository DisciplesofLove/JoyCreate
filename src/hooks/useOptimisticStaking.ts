/**
 * TanStack Query hooks for the OptimisticStaking bonded-attestation contract.
 * Backed by the IPC channels registered in
 *   src/ipc/handlers/optimistic_staking_handlers.ts
 *
 * Reads use `useQuery`; writes use `useMutation` and invalidate the relevant
 * read queries on success.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  IpcClient,
  type OptimisticStakingAttestation,
  type OptimisticStakingChainId,
  type OptimisticStakingConfig,
  type OptimisticStakingStake,
  type OptimisticStakingTxResult,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function useOptimisticStakingConfig(chain?: OptimisticStakingChainId) {
  return useQuery<OptimisticStakingConfig>({
    queryKey: ["optimistic-staking", "config", chain ?? "default"],
    queryFn: () => ipc.optimisticStakingGetConfig({ chain }),
  });
}

export function useAttestation(digest: string | undefined, chain?: OptimisticStakingChainId) {
  return useQuery<OptimisticStakingAttestation>({
    queryKey: ["optimistic-staking", "attestation", chain ?? "default", digest],
    queryFn: () => ipc.optimisticStakingGetAttestation({ chain, digest: digest as string }),
    enabled: Boolean(digest),
  });
}

export function useStakeOf(validator: string | undefined, chain?: OptimisticStakingChainId) {
  return useQuery<OptimisticStakingStake>({
    queryKey: ["optimistic-staking", "stake", chain ?? "default", validator],
    queryFn: () => ipc.optimisticStakingStakeOf({ chain, validator: validator as string }),
    enabled: Boolean(validator),
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function useDepositStake() {
  const qc = useQueryClient();
  return useMutation<
    OptimisticStakingTxResult,
    Error,
    { chain?: OptimisticStakingChainId; amount: string }
  >({
    mutationFn: (args) => ipc.optimisticStakingDeposit(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["optimistic-staking", "stake"] });
    },
    onError: (err) => toast.error(`Deposit failed: ${err.message}`),
  });
}

export function useWithdrawStake() {
  const qc = useQueryClient();
  return useMutation<
    OptimisticStakingTxResult,
    Error,
    { chain?: OptimisticStakingChainId; amount: string }
  >({
    mutationFn: (args) => ipc.optimisticStakingWithdraw(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["optimistic-staking", "stake"] });
    },
    onError: (err) => toast.error(`Withdraw failed: ${err.message}`),
  });
}

export function useSubmitAttestation() {
  const qc = useQueryClient();
  return useMutation<
    OptimisticStakingTxResult,
    Error,
    {
      chain?: OptimisticStakingChainId;
      digest: string;
      signer: string;
      score: string;
      bond: string;
      signature: string;
    }
  >({
    mutationFn: (args) => ipc.optimisticStakingSubmitAttestation(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({
        queryKey: ["optimistic-staking", "attestation", vars.chain ?? "default", vars.digest],
      });
      qc.invalidateQueries({ queryKey: ["optimistic-staking", "stake"] });
    },
    onError: (err) => toast.error(`Submit attestation failed: ${err.message}`),
  });
}

export function useChallengeSignature() {
  const qc = useQueryClient();
  return useMutation<
    OptimisticStakingTxResult,
    Error,
    { chain?: OptimisticStakingChainId; digest: string }
  >({
    mutationFn: (args) => ipc.optimisticStakingChallengeSignature(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({
        queryKey: ["optimistic-staking", "attestation", vars.chain ?? "default", vars.digest],
      });
      qc.invalidateQueries({ queryKey: ["optimistic-staking", "stake"] });
    },
    onError: (err) => toast.error(`Challenge failed: ${err.message}`),
  });
}

export function useOpenDispute() {
  const qc = useQueryClient();
  return useMutation<
    OptimisticStakingTxResult,
    Error,
    { chain?: OptimisticStakingChainId; digest: string }
  >({
    mutationFn: (args) => ipc.optimisticStakingOpenDispute(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({
        queryKey: ["optimistic-staking", "attestation", vars.chain ?? "default", vars.digest],
      });
    },
    onError: (err) => toast.error(`Open dispute failed: ${err.message}`),
  });
}

export function useResolveDispute() {
  const qc = useQueryClient();
  return useMutation<
    OptimisticStakingTxResult,
    Error,
    { chain?: OptimisticStakingChainId; digest: string; validatorSlashed: boolean }
  >({
    mutationFn: (args) => ipc.optimisticStakingResolveDispute(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({
        queryKey: ["optimistic-staking", "attestation", vars.chain ?? "default", vars.digest],
      });
      qc.invalidateQueries({ queryKey: ["optimistic-staking", "stake"] });
    },
    onError: (err) => toast.error(`Resolve dispute failed: ${err.message}`),
  });
}

export function useFinalizeAttestation() {
  const qc = useQueryClient();
  return useMutation<
    OptimisticStakingTxResult,
    Error,
    { chain?: OptimisticStakingChainId; digest: string }
  >({
    mutationFn: (args) => ipc.optimisticStakingFinalize(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({
        queryKey: ["optimistic-staking", "attestation", vars.chain ?? "default", vars.digest],
      });
      qc.invalidateQueries({ queryKey: ["optimistic-staking", "stake"] });
    },
    onError: (err) => toast.error(`Finalize failed: ${err.message}`),
  });
}
