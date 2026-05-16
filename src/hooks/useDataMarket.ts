/**
 * TanStack Query hooks for the Data Market — Provenance + Smart-Lease.
 * Backed by the IPC channels registered in
 *   src/ipc/handlers/data_market_handlers.ts
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IpcClient,
  type DataLeaseCreateListingArgs,
  type DataLeaseGrantRow,
  type DataLeaseListingRecord,
  type DataLeaseListingRow,
  type DataLeasePurchaseResult,
  type DataMarketChainId,
  type DataMarketStatus,
  type DataProvenanceMintArgs,
  type DataProvenanceMintResult,
  type DataProvenanceRecord,
  type DataProvenanceRow,
} from "@/ipc/ipc_client";

const ipc = IpcClient.getInstance();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function useDataMarketStatus(chain: DataMarketChainId | undefined) {
  return useQuery<DataMarketStatus>({
    queryKey: ["data-market", "status", chain],
    queryFn: () => ipc.dataMarketStatus({ chain: chain! }),
    enabled: Boolean(chain),
  });
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export function useProvenanceTokens(args?: {
  chain?: DataMarketChainId;
  creator?: string;
  limit?: number;
}) {
  return useQuery<DataProvenanceRow[]>({
    queryKey: ["data-market", "provenance", "list", args ?? {}],
    queryFn: () => ipc.dataProvenanceList(args),
  });
}

export function useProvenanceToken(
  chain: DataMarketChainId | undefined,
  tokenId: string | undefined,
) {
  return useQuery<DataProvenanceRecord>({
    queryKey: ["data-market", "provenance", "get", chain, tokenId],
    queryFn: () => ipc.dataProvenanceGet({ chain: chain!, tokenId: tokenId! }),
    enabled: Boolean(chain && tokenId),
  });
}

export function useMintProvenance() {
  const qc = useQueryClient();
  return useMutation<DataProvenanceMintResult, Error, DataProvenanceMintArgs>({
    mutationFn: (args) => ipc.dataProvenanceMint(args),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["data-market", "provenance"] });
      toast.success(`Provenance token #${result.tokenId} minted`);
    },
    onError: (err) => {
      toast.error(`Mint failed: ${err.message}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Lease listings
// ---------------------------------------------------------------------------

export function useDataLeaseListings(args?: {
  chain?: DataMarketChainId;
  creator?: string;
  activeOnly?: boolean;
  limit?: number;
}) {
  return useQuery<DataLeaseListingRow[]>({
    queryKey: ["data-market", "lease", "listings", args ?? {}],
    queryFn: () => ipc.dataLeaseListListings(args),
  });
}

export function useDataLeaseListing(
  chain: DataMarketChainId | undefined,
  listingId: string | undefined,
) {
  return useQuery<DataLeaseListingRecord>({
    queryKey: ["data-market", "lease", "listing", chain, listingId],
    queryFn: () => ipc.dataLeaseGetListing({ chain: chain!, listingId: listingId! }),
    enabled: Boolean(chain && listingId),
  });
}

export function useCreateLeaseListing() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, DataLeaseCreateListingArgs>({
    mutationFn: (args) => ipc.dataLeaseCreateListing(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["data-market", "lease", "listings"] });
      toast.success("Listing created");
    },
    onError: (err) => {
      toast.error(`Create listing failed: ${err.message}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Lease purchase / grants
// ---------------------------------------------------------------------------

export function usePurchaseLease() {
  const qc = useQueryClient();
  return useMutation<
    DataLeasePurchaseResult,
    Error,
    { chain: DataMarketChainId; listingId: string; priceWei: string }
  >({
    mutationFn: (args) => ipc.dataLeasePurchase(args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["data-market", "lease"] });
      toast.success("Lease purchased — Lit relayer notified");
    },
    onError: (err) => {
      toast.error(`Purchase failed: ${err.message}`);
    },
  });
}

export function useMyLeaseGrants(args?: {
  chain?: DataMarketChainId;
  lessee?: string;
  limit?: number;
}) {
  return useQuery<DataLeaseGrantRow[]>({
    queryKey: ["data-market", "lease", "grants", args ?? {}],
    queryFn: () => ipc.dataLeaseListMyGrants(args),
  });
}

export function useHasActiveLease(args: {
  chain: DataMarketChainId | undefined;
  listingId: string | undefined;
  lessee: string | undefined;
}) {
  return useQuery<boolean>({
    queryKey: ["data-market", "lease", "has-active", args],
    queryFn: () =>
      ipc.dataLeaseHasActive({
        chain: args.chain!,
        listingId: args.listingId!,
        lessee: args.lessee!,
      }),
    enabled: Boolean(args.chain && args.listingId && args.lessee),
  });
}
