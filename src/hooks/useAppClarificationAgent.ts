/**
 * useAppClarificationAgent
 *
 * Drives the App Clarification agent from React components. Subscribes to
 * the IPC event stream and exposes a small state machine the Quick Start
 * cockpit can render.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  appClarificationClient,
  type BuildBrief,
  type ClarificationEvent,
  type ClarificationRunResult,
  type QuickStartConfig,
} from "@/ipc/app_clarification_client";

export type ClarificationStatus =
  | "idle"
  | "starting"
  | "thinking"
  | "asking"
  | "ready"
  | "error"
  | "cancelled";

export interface ClarificationQuestion {
  text: string;
  suggestions?: string[];
  allowFreeform?: boolean;
}

export interface ClarificationState {
  status: ClarificationStatus;
  runId: string | null;
  question: ClarificationQuestion | null;
  brief: BuildBrief | null;
  error: string | null;
  /** Brief, human-readable trail of agent activity (most recent last). */
  history: string[];
}

const initialState: ClarificationState = {
  status: "idle",
  runId: null,
  question: null,
  brief: null,
  error: null,
  history: [],
};

export function useAppClarificationAgent() {
  const [state, setState] = useState<ClarificationState>(initialState);
  // Pending run promise — reserved for future use; kept null today.
  const pendingRef = useRef<{
    runId: string | null;
    resolve: (r: ClarificationRunResult) => void;
    reject: (err: Error) => void;
  } | null>(null);
  // Skip-now promise: resolved synchronously by `cancel()` so the caller's
  // `await start(...)` unblocks immediately, even if the IPC cancel hasn't
  // round-tripped yet (or no runId exists yet).
  const skipRef = useRef<{
    resolve: (r: ClarificationRunResult) => void;
  } | null>(null);
  // Track the latest runId via a ref so `cancel` doesn't depend on stale
  // state inside the same render commit.
  const latestRunIdRef = useRef<string | null>(null);

  // One subscription for the whole hook lifetime. Routes events by runId.
  useEffect(() => {
    const off = appClarificationClient.onEvent((evt) => {
      // Ignore stale events for runs we don't track.
      if (
        latestRunIdRef.current &&
        evt.runId !== latestRunIdRef.current &&
        evt.kind !== "started"
      ) {
        return;
      }
      handleEvent(evt);
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEvent(evt: ClarificationEvent) {
    switch (evt.kind) {
      case "started":
        latestRunIdRef.current = evt.runId;
        setState((s) => ({
          ...s,
          status: "thinking",
          runId: evt.runId,
          history: [...s.history, "Agent started"].slice(-30),
        }));
        break;
      case "thinking":
        setState((s) => ({
          ...s,
          status: s.status === "asking" ? s.status : "thinking",
        }));
        break;
      case "question":
        setState((s) => ({
          ...s,
          status: "asking",
          question: evt.question ?? null,
          history: [
            ...s.history,
            `Q: ${evt.question?.text ?? "(no question text)"}`,
          ].slice(-30),
        }));
        break;
      case "answer-received":
        setState((s) => ({
          ...s,
          status: "thinking",
          question: null,
          history: [
            ...s.history,
            `A: ${evt.message?.slice(0, 80) ?? ""}`,
          ].slice(-30),
        }));
        break;
      case "brief":
        setState((s) => ({
          ...s,
          brief: evt.brief ?? null,
          history: [...s.history, "Brief drafted"].slice(-30),
        }));
        break;
      case "error":
        setState((s) => ({
          ...s,
          status: "error",
          error: evt.error ?? "Unknown agent error",
        }));
        break;
      case "done":
        // The IPC `run` promise also resolves; we let that drive the
        // pendingRef. Just refresh status to a terminal one.
        setState((s) => ({
          ...s,
          status: s.brief ? "ready" : s.status === "error" ? s.status : "cancelled",
        }));
        break;
    }
  }

  const start = useCallback(
    async (opts: {
      prompt: string;
      config?: QuickStartConfig;
    }): Promise<ClarificationRunResult> => {
      // Reset visible state but keep history for debugging continuity.
      setState((s) => ({
        ...initialState,
        history: [...s.history, "—"].slice(-30),
        status: "starting",
      }));
      latestRunIdRef.current = null;

      // A skip-now promise the user can resolve via `cancel()` so the
      // caller (e.g. handleSubmit) is never stuck awaiting the IPC.
      const skipPromise = new Promise<ClarificationRunResult>((resolve) => {
        skipRef.current = { resolve };
      });

      try {
        const result = await Promise.race([
          appClarificationClient.run({
            prompt: opts.prompt,
            config: opts.config,
          }),
          skipPromise,
        ]);
        skipRef.current = null;
        // Settle terminal state if it didn't already happen via events.
        setState((s) => ({
          ...s,
          status: result.finished ? "ready" : "cancelled",
          runId: result.runId,
          brief: result.brief,
        }));
        return result;
      } catch (err) {
        skipRef.current = null;
        const message = (err as Error).message;
        setState((s) => ({ ...s, status: "error", error: message }));
        throw err;
      }
    },
    [],
  );

  const answer = useCallback(async (text: string) => {
    const runId = latestRunIdRef.current ?? state.runId;
    if (!runId) return;
    await appClarificationClient.answer(runId, text);
  }, [state.runId]);

  const cancel = useCallback(async () => {
    // 1. Unblock any in-flight `start()` immediately with a synthetic
    //    "skipped" result. The caller will see `finished: true` but
    //    `brief: null`-equivalent fields, and proceed with the raw prompt.
    if (skipRef.current) {
      const runId = latestRunIdRef.current ?? "skipped";
      skipRef.current.resolve({
        runId,
        // Empty brief sentinel — home.tsx falls back to the raw prompt
        // when title/refinedPrompt are empty.
        brief: {
          title: "",
          summary: "",
          projectType: "app",
          framework: "react",
          uiLibrary: "shadcn",
          category: "other",
          buildMode: "chat",
          styleHints: {},
          deploymentTargets: ["web"],
          features: [],
          knowledgeNotes: "",
          refinedPrompt: "",
        },
        finished: true,
      });
      skipRef.current = null;
    }
    setState((s) => ({ ...s, status: "cancelled", question: null }));

    // 2. Fire-and-forget the IPC cancel so the main-process agent aborts
    //    its stream. We don't await — UI must not wait on this.
    const runId = latestRunIdRef.current ?? state.runId;
    if (runId) {
      appClarificationClient.cancel(runId).catch(() => {
        /* already finished — ignore */
      });
    }
  }, [state.runId]);

  const reset = useCallback(() => {
    setState(initialState);
    pendingRef.current = null;
    skipRef.current = null;
    latestRunIdRef.current = null;
  }, []);

  return { state, start, answer, cancel, reset };
}
