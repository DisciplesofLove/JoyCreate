/**
 * TanStack Query hooks for the ERC-8004 Trustless Agents registries.
 * Backed by the IPC channels registered in
 *   src/ipc/handlers/erc8004_handlers.ts
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  IpcClient,
  type Erc8004AgentRecord,
  type Erc8004ChainId,
  type Erc8004RegisterAgentResult,
  type Erc8004ReputationScore,
  type Erc8004Status,
  type Erc8004ValidationRecord,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

// ---------------------------------------------------------------------------
// Status / Identity reads
// ---------------------------------------------------------------------------

export function useErc8004Status(chain?: Erc8004ChainId) {
  return useQuery<Erc8004Status>({
    queryKey: ["erc8004", "status", chain ?? "default"],
    queryFn: () => ipc.erc8004Status({ chain }),
  });
}

export function useErc8004AgentCount(chain?: Erc8004ChainId) {
  return useQuery<{ total: string }>({
    queryKey: ["erc8004", "agent-count", chain ?? "default"],
    queryFn: () => ipc.erc8004AgentCount({ chain }),
  });
}

export function useErc8004Agent(agentId: string | undefined, chain?: Erc8004ChainId) {
  return useQuery<Erc8004AgentRecord>({
    queryKey: ["erc8004", "agent", chain ?? "default", agentId],
    queryFn: () => ipc.erc8004GetAgent({ chain, agentId: agentId! }),
    enabled: Boolean(agentId),
  });
}

export function useErc8004ResolveByAddress(
  agentAddress: string | undefined,
  chain?: Erc8004ChainId,
) {
  return useQuery<{ agentId: string }>({
    queryKey: ["erc8004", "resolve-address", chain ?? "default", agentAddress],
    queryFn: () => ipc.erc8004ResolveByAddress({ chain, agentAddress: agentAddress! }),
    enabled: Boolean(agentAddress),
  });
}

export function useErc8004Reputation(serverId: string | undefined, chain?: Erc8004ChainId) {
  return useQuery<Erc8004ReputationScore>({
    queryKey: ["erc8004", "reputation", chain ?? "default", serverId],
    queryFn: () => ipc.erc8004GetReputation({ chain, serverId: serverId! }),
    enabled: Boolean(serverId),
  });
}

export function useErc8004Validation(dataHash: string | undefined, chain?: Erc8004ChainId) {
  return useQuery<Erc8004ValidationRecord>({
    queryKey: ["erc8004", "validation", chain ?? "default", dataHash],
    queryFn: () => ipc.erc8004GetValidation({ chain, dataHash: dataHash! }),
    enabled: Boolean(dataHash),
  });
}

// ---------------------------------------------------------------------------
// Identity writes
// ---------------------------------------------------------------------------

export function useRegisterAgent() {
  const qc = useQueryClient();
  return useMutation<
    Erc8004RegisterAgentResult,
    Error,
    { chain?: Erc8004ChainId; agentDomain: string }
  >({
    mutationFn: (args) => ipc.erc8004RegisterAgent(args),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["erc8004"] });
      toast.success(`Agent #${result.agentId} registered on-chain`);
    },
    onError: (err) => toast.error(`Agent registration failed: ${err.message}`),
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: Erc8004ChainId; agentId: string; newDomain: string; newAddress: string }
  >({
    mutationFn: (args) => ipc.erc8004UpdateAgent(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erc8004", "agent"] });
      toast.success("Agent updated");
    },
    onError: (err) => toast.error(`Agent update failed: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// Reputation writes
// ---------------------------------------------------------------------------

export function useAcceptFeedback() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: Erc8004ChainId; clientId: string; serverId: string }
  >({
    mutationFn: (args) => ipc.erc8004AcceptFeedback(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erc8004", "reputation"] });
      toast.success("Feedback authorized");
    },
    onError: (err) => toast.error(`Accept feedback failed: ${err.message}`),
  });
}

export function useSubmitFeedback() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: Erc8004ChainId; clientId: string; serverId: string; score: number; feedbackUri?: string }
  >({
    mutationFn: (args) => ipc.erc8004SubmitFeedback(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erc8004", "reputation"] });
      toast.success("Feedback submitted");
    },
    onError: (err) => toast.error(`Submit feedback failed: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// Validation writes
// ---------------------------------------------------------------------------

export function useValidationRequest() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: Erc8004ChainId; validator: string; serverAgentId: string; dataHash: string }
  >({
    mutationFn: (args) => ipc.erc8004ValidationRequest(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erc8004", "validation"] });
      toast.success("Validation requested");
    },
    onError: (err) => toast.error(`Validation request failed: ${err.message}`),
  });
}

export function useValidationResponse() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: Erc8004ChainId; dataHash: string; response: number }
  >({
    mutationFn: (args) => ipc.erc8004ValidationResponse(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["erc8004", "validation"] });
      toast.success("Validation response recorded");
    },
    onError: (err) => toast.error(`Validation response failed: ${err.message}`),
  });
}
