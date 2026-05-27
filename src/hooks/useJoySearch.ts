/**
 * JoySearch React hooks — TanStack Query wrappers around the JoySearch
 * IPC client.
 */

import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { joySearchClient } from "@/ipc/clients/joy_search_client";
import type {
  JoySearchAnswerResponse,
  JoySearchEngine,
  JoySearchLensMode,
  JoySearchLensResponse,
  JoySearchQueryResponse,
} from "@/types/joy_search";

export const joySearchKeys = {
  all: ["joy-search"] as const,
  query: (q: string, opts: QueryOpts) =>
    [
      "joy-search",
      "query",
      q,
      opts.page ?? 1,
      opts.region ?? "",
      opts.safe ?? "moderate",
      (opts.engines ?? []).slice().sort().join(","),
      !!opts.aiRerank,
    ] as const,
  answer: (q: string) => ["joy-search", "answer", q] as const,
  suggest: (q: string) => ["joy-search", "suggest", q] as const,
  lens: (url: string, mode: JoySearchLensMode, lang?: string) =>
    ["joy-search", "lens", url, mode, lang ?? ""] as const,
};

interface QueryOpts {
  page?: number;
  region?: string;
  safe?: "off" | "moderate" | "strict";
  engines?: JoySearchEngine[];
  aiRerank?: boolean;
  enabled?: boolean;
}

export function useJoySearchQuery(
  q: string,
  opts: QueryOpts = {},
): UseQueryResult<JoySearchQueryResponse> {
  const enabled = opts.enabled ?? !!q.trim();
  return useQuery({
    queryKey: joySearchKeys.query(q, opts),
    queryFn: () =>
      joySearchClient.query({
        q,
        page: opts.page,
        region: opts.region,
        safe: opts.safe,
        engines: opts.engines,
        aiRerank: opts.aiRerank,
      }),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

export function useJoySearchAnswer(
  q: string,
  opts: { enabled?: boolean } = {},
): UseQueryResult<JoySearchAnswerResponse> {
  const enabled = opts.enabled ?? !!q.trim();
  return useQuery({
    queryKey: joySearchKeys.answer(q),
    queryFn: () => joySearchClient.answer({ q }),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}

/** Debounced autocomplete suggestions. */
export function useJoySearchSuggest(q: string, debounceMs = 200): string[] {
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), debounceMs);
    return () => clearTimeout(t);
  }, [q, debounceMs]);

  const trimmed = debounced.trim();
  const { data } = useQuery({
    queryKey: joySearchKeys.suggest(trimmed),
    queryFn: () => joySearchClient.suggest({ q: trimmed }),
    enabled: trimmed.length >= 2,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return data?.suggestions ?? [];
}

/** On-demand lens runner (mutation). */
export function useJoySearchLens() {
  return useMutation({
    mutationFn: (params: {
      url: string;
      mode: JoySearchLensMode;
      targetLang?: string;
    }): Promise<JoySearchLensResponse> => joySearchClient.lens(params),
  });
}
