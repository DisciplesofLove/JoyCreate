/**
 * Genius Core renderer-worker React hooks.
 *
 * These run inference *inside the renderer process* via a Web Worker. Use
 * them when you want to keep the React thread responsive but avoid the IPC
 * roundtrip to the main process (e.g. for small WebGPU-friendly models).
 *
 * For the main-process backend (CPU/DirectML/CUDA), see {@link useGeniusCore}
 * — its `useGeniusCoreInfer` hook routes through IPC instead.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  OnnxRuntimeRenderer,
  type OnnxRuntimeRendererOptions,
} from "@/lib/genius_core/onnx_runtime_renderer";
import { findBaseModel } from "@/lib/genius_core/model_format";
import type {
  GeniusCoreInferRequest,
  GeniusCoreInferResponse,
} from "@/lib/genius_core";

export interface UseGeniusCoreRendererOptions {
  /** Base model id from the curated catalogue. */
  baseModelId: string;
  /** Optional worker factory for tests. */
  workerFactory?: OnnxRuntimeRendererOptions["workerFactory"];
}

export interface UseGeniusCoreRendererResult {
  /** Imperative one-shot inference. */
  infer: (req: GeniusCoreInferRequest) => Promise<GeniusCoreInferResponse>;
  /** Imperative streaming inference. */
  streamInfer: (
    req: GeniusCoreInferRequest,
    onChunk: (chunk: string) => void,
  ) => Promise<GeniusCoreInferResponse>;
  /** Eagerly initialise the worker + load the base model. */
  preload: () => Promise<void>;
  /** Tear down the worker. Automatically called on unmount. */
  shutdown: () => Promise<void>;
}

/**
 * Spawns a single {@link OnnxRuntimeRenderer} for the lifetime of the
 * component and exposes imperative `infer` / `streamInfer` helpers. The
 * underlying worker is created lazily on first call and torn down on unmount.
 */
export function useGeniusCoreRenderer(
  opts: UseGeniusCoreRendererOptions,
): UseGeniusCoreRendererResult {
  const clientRef = useRef<OnnxRuntimeRenderer | null>(null);
  const { baseModelId, workerFactory } = opts;

  const meta = useMemo(() => findBaseModel(baseModelId), [baseModelId]);

  const getClient = useCallback((): OnnxRuntimeRenderer => {
    if (!meta) {
      throw new Error(`Unknown Genius Core base model: ${baseModelId}`);
    }
    if (!clientRef.current) {
      clientRef.current = new OnnxRuntimeRenderer({
        hfRepo: meta.hfRepo,
        dtype: meta.quantization,
        workerFactory,
      });
    }
    return clientRef.current;
  }, [meta, baseModelId, workerFactory]);

  const infer = useCallback(
    (req: GeniusCoreInferRequest) => getClient().infer(req),
    [getClient],
  );
  const streamInfer = useCallback(
    (req: GeniusCoreInferRequest, onChunk: (c: string) => void) =>
      getClient().streamInfer(req, onChunk),
    [getClient],
  );
  const preload = useCallback(async () => {
    await getClient().loadBase();
  }, [getClient]);
  const shutdown = useCallback(async () => {
    const c = clientRef.current;
    clientRef.current = null;
    if (c) await c.shutdown();
  }, []);

  // Tear down on unmount or when the configured model changes.
  useEffect(() => {
    return () => {
      const c = clientRef.current;
      clientRef.current = null;
      if (c) void c.shutdown();
    };
  }, [baseModelId]);

  return { infer, streamInfer, preload, shutdown };
}
