/**
 * TanStack Query hooks for the verifiable-inference (TEE) attestation layer.
 * Backed by the IPC channels registered in
 *   src/ipc/handlers/tee_handlers.ts
 *
 * Default mode is "local" (zero cost, no chain writes). Switch the active
 * provider with JOY_TEE_MODE=optimistic|lit|nitro.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  IpcClient,
  type TeeStatus,
  type TeeVerifiedInferenceRecord,
  type X402ChainId,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

// ---------------------------------------------------------------------------
// Status (read)
// ---------------------------------------------------------------------------

export function useTeeStatus() {
  return useQuery<TeeStatus>({
    queryKey: ["tee", "status"],
    queryFn: () => ipc.teeStatus(),
  });
}

// ---------------------------------------------------------------------------
// Run verified inference (write)
// ---------------------------------------------------------------------------

export function useRunVerifiedInference() {
  const queryClient = useQueryClient();
  return useMutation<
    TeeVerifiedInferenceRecord,
    Error,
    {
      chain?: X402ChainId;
      modelId: string;
      input: string;
      output: string;
      serverAgentId?: string;
      score?: number;
      writeOnChain?: boolean;
      anchorCelestia?: boolean;
    }
  >({
    mutationFn: (args) => ipc.teeRunVerifiedInference(args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tee", "status"] });
    },
    onError: (err) => {
      toast.error(`Verified inference failed: ${err.message}`);
    },
  });
}
