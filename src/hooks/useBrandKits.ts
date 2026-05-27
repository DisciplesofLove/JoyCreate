/**
 * TanStack Query hooks for the Brand Kit IPC channels.
 *
 * Reads use `useQuery`; writes use `useMutation` and invalidate the list /
 * single-kit caches on success.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { IpcClient } from "@/ipc/ipc_client";
import type {
  BrandKitCreateInput,
  BrandKitDto,
  BrandKitUpdateInput,
  BrandKitUploadInput,
} from "@/ipc/handlers/brand_kit_handlers";

export const BRAND_KIT_LIST_KEY = ["brand-kit", "list"] as const;
export const brandKitDetailKey = (id: number) =>
  ["brand-kit", "detail", id] as const;

export function useBrandKits() {
  return useQuery<BrandKitDto[]>({
    queryKey: BRAND_KIT_LIST_KEY,
    queryFn: () => IpcClient.getInstance().listBrandKits(),
    staleTime: 60_000,
  });
}

export function useBrandKit(id: number | null | undefined) {
  return useQuery<BrandKitDto | null>({
    queryKey: brandKitDetailKey(id ?? -1),
    queryFn: () => IpcClient.getInstance().getBrandKit(id as number),
    enabled: typeof id === "number" && id > 0,
  });
}

export function useCreateBrandKit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BrandKitCreateInput) =>
      IpcClient.getInstance().createBrandKit(input),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: BRAND_KIT_LIST_KEY });
      qc.setQueryData(brandKitDetailKey(row.id), row);
    },
  });
}

export function useUpdateBrandKit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: number; updates: BrandKitUpdateInput }) =>
      IpcClient.getInstance().updateBrandKit(args.id, args.updates),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: BRAND_KIT_LIST_KEY });
      qc.setQueryData(brandKitDetailKey(row.id), row);
    },
  });
}

export function useDeleteBrandKit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => IpcClient.getInstance().deleteBrandKit(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: BRAND_KIT_LIST_KEY });
      qc.removeQueries({ queryKey: brandKitDetailKey(id) });
    },
  });
}

export function useUploadBrandKitAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BrandKitUploadInput) =>
      IpcClient.getInstance().uploadBrandKitAsset(input),
    onSuccess: (_res, input) => {
      qc.invalidateQueries({ queryKey: BRAND_KIT_LIST_KEY });
      qc.invalidateQueries({ queryKey: brandKitDetailKey(input.brandKitId) });
    },
  });
}
