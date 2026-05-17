/**
 * Genius Core — order-respecting edit logger renderer hook.
 *
 * Thin wrapper around the `genius-core:record-edit` IPC channel for
 * studio editors (image, video, dataset, code). Wires capture under a
 * settings-guarded `useEffect` and exposes ergonomic helpers:
 *
 *   const { record, flush, recordCursor, recordTextChange } =
 *     useGeniusCoreEditLogger({ projectId, fileId });
 *   record({ op: "insert", range, text });
 *
 * The renderer never reads settings directly — the main-process logger
 * applies its privacy gate on every `record()` call, so toggling consent
 * mid-session takes effect immediately without the renderer needing to
 * subscribe.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import { IpcClient } from "@/ipc/ipc_client";
import type {
  EditOp,
  EditRange,
  RecordInput,
} from "@/lib/genius_core/edit_logger";

export interface UseGeniusCoreEditLoggerOptions {
  projectId: number | null | undefined;
  fileId: string | null | undefined;
  /**
   * When false, the hook becomes a no-op and `flush` resolves to
   * `{ flushed: false }`. Use to gate the entire surface on a per-route
   * basis (e.g., disable in incognito-style modes).
   */
  enabled?: boolean;
  /**
   * Auto-flush the buffer when the hook unmounts. Defaults to true so
   * route transitions never lose pending entries.
   */
  flushOnUnmount?: boolean;
}

export interface RecordHelper {
  op: EditOp;
  range: EditRange;
  text?: string;
  occurredAtMs?: number;
}

export interface UseGeniusCoreEditLoggerResult {
  /** Low-level: fires one IPC call. Returns false when disabled. */
  record: (input: RecordHelper) => Promise<boolean>;
  /** Convenience: cursor / selection move. */
  recordCursor: (range: EditRange) => Promise<boolean>;
  /** Convenience: insert / delete with payload text. */
  recordTextChange: (
    op: "insert" | "delete",
    range: EditRange,
    text: string,
  ) => Promise<boolean>;
  /** Convenience: AI suggestion verdict. */
  recordAiVerdict: (
    accepted: boolean,
    range: EditRange,
  ) => Promise<boolean>;
  /** Force-flush the main-side buffer. */
  flush: () => Promise<{ flushed: boolean }>;
}

const ipc = () => IpcClient.getInstance();

export function useGeniusCoreEditLogger(
  opts: UseGeniusCoreEditLoggerOptions,
): UseGeniusCoreEditLoggerResult {
  const { projectId, fileId } = opts;
  const enabled = opts.enabled !== false;
  const flushOnUnmount = opts.flushOnUnmount !== false;

  const ready = useMemo(() => {
    if (!enabled) return false;
    if (typeof projectId !== "number" || !Number.isInteger(projectId)) return false;
    if (projectId <= 0) return false;
    if (typeof fileId !== "string" || fileId.length === 0) return false;
    return true;
  }, [enabled, projectId, fileId]);

  const readyRef = useRef(ready);
  const projectRef = useRef(projectId);
  const fileRef = useRef(fileId);
  useEffect(() => {
    readyRef.current = ready;
    projectRef.current = projectId;
    fileRef.current = fileId;
  }, [ready, projectId, fileId]);

  const record = useCallback(async (input: RecordHelper): Promise<boolean> => {
    if (!readyRef.current) return false;
    const pid = projectRef.current;
    const fid = fileRef.current;
    if (typeof pid !== "number" || typeof fid !== "string") return false;
    const payload: RecordInput = {
      projectId: pid,
      fileId: fid,
      op: input.op,
      range: input.range,
      text: input.text,
      occurredAtMs: input.occurredAtMs,
    };
    const res = await ipc().geniusCoreRecordEdit(payload);
    return res.accepted;
  }, []);

  const recordCursor = useCallback(
    (range: EditRange) => record({ op: "cursor", range }),
    [record],
  );

  const recordTextChange = useCallback(
    (op: "insert" | "delete", range: EditRange, text: string) =>
      record({ op, range, text }),
    [record],
  );

  const recordAiVerdict = useCallback(
    (accepted: boolean, range: EditRange) =>
      record({ op: accepted ? "ai_accept" : "ai_reject", range }),
    [record],
  );

  const flush = useCallback(async (): Promise<{ flushed: boolean }> => {
    if (!readyRef.current) return { flushed: false };
    return ipc().geniusCoreFlushEditLog();
  }, []);

  useEffect(() => {
    if (!flushOnUnmount) return;
    return () => {
      if (readyRef.current) {
        ipc()
          .geniusCoreFlushEditLog()
          .catch(() => {
            /* unmount flush is best-effort */
          });
      }
    };
  }, [flushOnUnmount]);

  return { record, recordCursor, recordTextChange, recordAiVerdict, flush };
}
