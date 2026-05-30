/**
 * TanStack Query hooks for the JOY Marketplace glue contracts —
 * StoreRegistry, EditionController and AgentMandate.
 * Backed by the IPC channels registered in
 *   src/ipc/handlers/glue_handlers.ts
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  IpcClient,
  type GlueChainId,
  type GlueDropRecord,
  type GlueMandateRecord,
  type GlueStoreRecord,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function useGlueStatus(chain?: GlueChainId) {
  return useQuery<{ chain: GlueChainId; ready: boolean }>({
    queryKey: ["glue", "status", chain ?? "default"],
    queryFn: () => ipc.glueStatus({ chain }),
  });
}

// ---------------------------------------------------------------------------
// StoreRegistry
// ---------------------------------------------------------------------------

export function useStoreCount(chain?: GlueChainId) {
  return useQuery<{ total: string }>({
    queryKey: ["glue", "store-count", chain ?? "default"],
    queryFn: () => ipc.glueStoreCount({ chain }),
  });
}

export function useStore(storeId: string | undefined, chain?: GlueChainId) {
  return useQuery<GlueStoreRecord>({
    queryKey: ["glue", "store", chain ?? "default", storeId],
    queryFn: () => ipc.glueGetStore({ chain, storeId: storeId! }),
    enabled: Boolean(storeId),
  });
}

export function useResolveStoreBySlug(slug: string | undefined, chain?: GlueChainId) {
  return useQuery<{ storeId: string }>({
    queryKey: ["glue", "store-by-slug", chain ?? "default", slug],
    queryFn: () => ipc.glueResolveStoreBySlug({ chain, slug: slug! }),
    enabled: Boolean(slug),
  });
}

export function useRegisterStore() {
  const qc = useQueryClient();
  return useMutation<
    { storeId: string; txHash: string; blockNumber: number },
    Error,
    { chain?: GlueChainId; slug: string; agentId?: string }
  >({
    mutationFn: (args) => ipc.glueRegisterStore(args),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["glue", "store-count"] });
      toast.success(`Store #${result.storeId} registered`);
    },
    onError: (err) => toast.error(`Store registration failed: ${err.message}`),
  });
}

export function useSetStoreAgent() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: GlueChainId; storeId: string; agentId: string }
  >({
    mutationFn: (args) => ipc.glueSetStoreAgent(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ["glue", "store", vars.chain ?? "default", vars.storeId] });
      toast.success("Store agent updated");
    },
    onError: (err) => toast.error(`Update failed: ${err.message}`),
  });
}

export function useTransferStore() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: GlueChainId; storeId: string; newOwner: string }
  >({
    mutationFn: (args) => ipc.glueTransferStore(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["glue", "store"] });
      toast.success("Store transferred");
    },
    onError: (err) => toast.error(`Transfer failed: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// EditionController
// ---------------------------------------------------------------------------

export function useDropCount(chain?: GlueChainId) {
  return useQuery<{ total: string }>({
    queryKey: ["glue", "drop-count", chain ?? "default"],
    queryFn: () => ipc.glueDropCount({ chain }),
  });
}

export function useDrop(dropId: string | undefined, chain?: GlueChainId) {
  return useQuery<GlueDropRecord>({
    queryKey: ["glue", "drop", chain ?? "default", dropId],
    queryFn: () => ipc.glueGetDrop({ chain, dropId: dropId! }),
    enabled: Boolean(dropId),
  });
}

export function useEditionBalance(
  dropId: string | undefined,
  account: string | undefined,
  chain?: GlueChainId,
) {
  return useQuery<{ balance: string }>({
    queryKey: ["glue", "edition-balance", chain ?? "default", dropId, account],
    queryFn: () => ipc.glueEditionBalance({ chain, dropId: dropId!, account: account! }),
    enabled: Boolean(dropId && account),
  });
}

export function useCreateDrop() {
  const qc = useQueryClient();
  return useMutation<
    { dropId: string; txHash: string; blockNumber: number },
    Error,
    {
      chain?: GlueChainId;
      storeId: string;
      assetLeaf: string;
      price?: string;
      maxSupply?: string;
      requiresProof?: boolean;
    }
  >({
    mutationFn: (args) => ipc.glueCreateDrop(args),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["glue", "drop-count"] });
      toast.success(`Drop #${result.dropId} created`);
    },
    onError: (err) => toast.error(`Create drop failed: ${err.message}`),
  });
}

export function useSetDropActive() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: GlueChainId; dropId: string; active: boolean }
  >({
    mutationFn: (args) => ipc.glueSetDropActive(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ["glue", "drop", vars.chain ?? "default", vars.dropId] });
      toast.success(vars.active ? "Drop opened" : "Drop closed");
    },
    onError: (err) => toast.error(`Update failed: ${err.message}`),
  });
}

export function useGrantProof() {
  return useMutation<
    { txHash: string },
    Error,
    { chain?: GlueChainId; dropId: string; account: string }
  >({
    mutationFn: (args) => ipc.glueGrantProof(args),
    onSuccess: () => toast.success("Proof-of-Use granted"),
    onError: (err) => toast.error(`Grant failed: ${err.message}`),
  });
}

export function useMintEdition() {
  const qc = useQueryClient();
  return useMutation<
    { tokenId: string; txHash: string; blockNumber: number },
    Error,
    { chain?: GlueChainId; dropId: string }
  >({
    mutationFn: (args) => ipc.glueMint(args),
    onSuccess: (result, vars) => {
      qc.invalidateQueries({ queryKey: ["glue", "drop", vars.chain ?? "default", vars.dropId] });
      qc.invalidateQueries({ queryKey: ["glue", "edition-balance"] });
      toast.success(`Minted token #${result.tokenId}`);
    },
    onError: (err) => toast.error(`Mint failed: ${err.message}`),
  });
}

// ---------------------------------------------------------------------------
// AgentMandate
// ---------------------------------------------------------------------------

export function useMandateCount(chain?: GlueChainId) {
  return useQuery<{ total: string }>({
    queryKey: ["glue", "mandate-count", chain ?? "default"],
    queryFn: () => ipc.glueMandateCount({ chain }),
  });
}

export function useMandate(mandateId: string | undefined, chain?: GlueChainId) {
  return useQuery<GlueMandateRecord>({
    queryKey: ["glue", "mandate", chain ?? "default", mandateId],
    queryFn: () => ipc.glueGetMandate({ chain, mandateId: mandateId! }),
    enabled: Boolean(mandateId),
  });
}

export function useMandateValid(mandateId: string | undefined, chain?: GlueChainId) {
  return useQuery<{ valid: boolean }>({
    queryKey: ["glue", "mandate-valid", chain ?? "default", mandateId],
    queryFn: () => ipc.glueIsMandateValid({ chain, mandateId: mandateId! }),
    enabled: Boolean(mandateId),
  });
}

export function useCreateMandate() {
  const qc = useQueryClient();
  return useMutation<
    { mandateId: string; txHash: string; blockNumber: number },
    Error,
    {
      chain?: GlueChainId;
      agent: string;
      spendLimit: string;
      expiry?: string;
      actionScope?: string;
    }
  >({
    mutationFn: (args) => ipc.glueCreateMandate(args),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["glue", "mandate-count"] });
      toast.success(`Mandate #${result.mandateId} created`);
    },
    onError: (err) => toast.error(`Create mandate failed: ${err.message}`),
  });
}

export function useRecordSpend() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: GlueChainId; mandateId: string; amount: string }
  >({
    mutationFn: (args) => ipc.glueRecordSpend(args),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ["glue", "mandate", vars.chain ?? "default", vars.mandateId] });
      toast.success("Spend recorded");
    },
    onError: (err) => toast.error(`Record spend failed: ${err.message}`),
  });
}

export function useRevokeMandate() {
  const qc = useQueryClient();
  return useMutation<
    { txHash: string },
    Error,
    { chain?: GlueChainId; mandateId: string }
  >({
    mutationFn: (args) => ipc.glueRevokeMandate(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["glue", "mandate"] });
      toast.success("Mandate revoked");
    },
    onError: (err) => toast.error(`Revoke failed: ${err.message}`),
  });
}
