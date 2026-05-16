/**
 * ProvenanceManifest — canonical record of how an AI artifact was produced.
 *
 * Persisted to `image_studio_images.provenance_json` /
 * `video_studio_videos.provenance_json` at generation time so consumers
 * (publish flow, marketplace listing, downstream agents) can verify the
 * artifact's lineage without re-querying the model layer.
 *
 * Designed to be cheap to extend: new fields go under `extra` to avoid
 * breaking callers that only read the top-level keys.
 */

export interface ProvenanceManifest {
  /** Schema version. Bump on breaking changes. */
  version: 1;
  /** Model identifier that produced the artifact (e.g. "stability-ai/sdxl"). */
  model: string;
  /** Provider/backing service (e.g. "replicate", "openai", "local"). */
  provider: string;
  /** User-supplied prompt that triggered the generation, if applicable. */
  prompt?: string;
  /** Negative prompt, if applicable. */
  negativePrompt?: string;
  /** Free-form generation parameters (seed, steps, cfg, etc). */
  params: Record<string, unknown>;
  /**
   * Optional references to training data / inputs (hashes, IPFS CIDs,
   * dataset ids). Empty array means "not declared".
   */
  trainingDataRefs: string[];
  /** Wallet/DID that signed this manifest (lowercased hex). */
  signerAddress?: string;
  /** ISO-8601 UTC timestamp the manifest was sealed. */
  signedAt: string;
  /** Hex signature over the canonical JSON of the other fields, if signed. */
  signatureHex?: string;
  /** Forward-compat bag for non-canonical fields. */
  extra?: Record<string, unknown>;
}

export function createProvenanceManifest(
  args: Omit<ProvenanceManifest, "version" | "signedAt" | "trainingDataRefs"> & {
    trainingDataRefs?: string[];
    signedAt?: string;
  },
): ProvenanceManifest {
  return {
    version: 1,
    model: args.model,
    provider: args.provider,
    prompt: args.prompt,
    negativePrompt: args.negativePrompt,
    params: args.params,
    trainingDataRefs: args.trainingDataRefs ?? [],
    signerAddress: args.signerAddress,
    signedAt: args.signedAt ?? new Date().toISOString(),
    signatureHex: args.signatureHex,
    extra: args.extra,
  };
}
