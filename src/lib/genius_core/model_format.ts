/**
 * Reference catalogue of Genius Core base models.
 *
 * Phase 1 ships with a single curated entry — Phi-3 Mini 4K Instruct in INT4
 * ONNX form, hosted by the official Microsoft repo on Hugging Face. Future
 * phases extend this list and load it from the on-chain model registry
 * (Stylus + Celestia), but the local fallback always wins for offline use.
 */

export type GeniusCoreExecutionProvider =
  | "auto"
  | "webgpu"
  | "directml"
  | "coreml"
  | "cuda"
  | "cpu";

export interface GeniusCoreBaseModel {
  /** Stable id used in settings + IPC. */
  id: string;
  /** Hugging Face repo id passed to transformers.js loaders. */
  hfRepo: string;
  /** Human-readable name for UI. */
  displayName: string;
  /** Quantization label (e.g. "q4", "q4f16", "fp16"). */
  quantization: string;
  /** Approximate disk footprint after download — used for VRAM budgeting. */
  approxBytes: number;
  /** Default context window the chat template assumes. */
  contextWindow: number;
  /** Execution providers we know this model has been validated on. */
  supportedProviders: GeniusCoreExecutionProvider[];
}

export const GENIUS_CORE_BASE_MODELS: ReadonlyArray<GeniusCoreBaseModel> = [
  {
    id: "phi-3-mini-4k-instruct-int4-onnx",
    hfRepo: "microsoft/Phi-3-mini-4k-instruct-onnx-web",
    displayName: "Phi-3 Mini 4K Instruct (INT4 ONNX)",
    quantization: "q4",
    approxBytes: 2_400_000_000,
    contextWindow: 4096,
    supportedProviders: ["auto", "webgpu", "directml", "cpu"],
  },
];

export function findBaseModel(id: string): GeniusCoreBaseModel | undefined {
  return GENIUS_CORE_BASE_MODELS.find((m) => m.id === id);
}
