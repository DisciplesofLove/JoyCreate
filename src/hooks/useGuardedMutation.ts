/**
 * useGuardedMutation — React Query mutation that wallet-signs every payload
 * with Neural Guard before invoking the IPC channel.
 *
 * Use this for any side-effecting "skill" channel (scrape, publish, mint,
 * export, …). Identical surface to `useMutation` except:
 *
 *   1. `channel` (the IPC channel name) is required.
 *   2. The mutation function automatically calls
 *      `IpcClient.getInstance().signAndInvoke(channel, payload, options)`.
 *   3. `options.agentDid` / `options.agentWallet` may be supplied to override
 *      the default (renderer's stored JoyWallet address).
 *
 * Example:
 *   const scrape = useGuardedMutation<ScrapeArgs, ScrapeResult>({
 *     channel: "scraper:run",
 *     onSuccess: () => qc.invalidateQueries({ queryKey: ["scrapes"] }),
 *   });
 *   scrape.mutate({ url, selector });
 */

import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { IpcClient } from "@/ipc/ipc_client";

export interface GuardedMutationOptions<TPayload, TResult, TError = Error>
  extends Omit<
    UseMutationOptions<TResult, TError, TPayload>,
    "mutationFn"
  > {
  /** Exact IPC channel to invoke. Must match the handler's channel string. */
  channel: string;
  /** Optional override of the agent identity to sign with. */
  agentDid?: string;
  /** Optional override of the wallet address (must match the active signer). */
  agentWallet?: string;
}

export function useGuardedMutation<
  TPayload,
  TResult = unknown,
  TError = Error,
>(
  options: GuardedMutationOptions<TPayload, TResult, TError>,
): UseMutationResult<TResult, TError, TPayload> {
  const { channel, agentDid, agentWallet, ...rest } = options;

  return useMutation<TResult, TError, TPayload>({
    ...rest,
    mutationFn: (payload: TPayload) =>
      IpcClient.getInstance().signAndInvoke<TPayload, TResult>(
        channel,
        payload,
        { agentDid, agentWallet },
      ),
  });
}
