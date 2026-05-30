/**
 * Provider-agnostic attestation layer for verifiable inference.
 *
 * Each provider takes an inference {input, output, modelId} and returns an
 * AttestationQuote — a signed claim binding inputHash + outputHash + modelId.
 * Downstream, the ValidationRegistry only consumes this quote; it does not care
 * which provider produced it. This lets a drop/agent choose its proof tier
 * (and price it through X402 + reputation) per the Web 4.0 design.
 *
 * Implemented here:
 *   - LocalProvider      → $0 dev stub, deterministic digest, no signing key needed.
 *   - OptimisticProvider → validator wallet signs the digest (raw ECDSA). ~$0.
 *   - LitProvider        → Lit Action + PKP threshold signature (gated on config).
 *   - NitroProvider      → hardware TEE quote via gateway (gated on config).
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  ATTESTATION_VERSION,
  proofKindForMode,
  resolveLitConfig,
  resolveNitroConfig,
  type AttestationProofKind,
  type TeeMode,
} from "@/config/tee";

const logger = log.scope("tee_attestation");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InferenceJob {
  /** Model identifier (e.g. local model name or a registry id). */
  modelId: string;
  /** Raw input prompt / payload that was sent to the model. */
  input: string;
  /** Raw output the model produced (computed by the caller, outside the proof). */
  output: string;
  /** Optional ERC-8004 agent id that ran the inference (the "server" agent). */
  serverAgentId?: string;
}

export interface AttestationQuote {
  version: typeof ATTESTATION_VERSION;
  mode: TeeMode;
  proofKind: AttestationProofKind;
  /** keccak256 of the UTF-8 input. */
  inputHash: string;
  /** keccak256 of the UTF-8 output. */
  outputHash: string;
  /** keccak256(inputHash ‖ outputHash ‖ modelId) — the on-chain dataHash. */
  digest: string;
  modelId: string;
  /** Address that produced/threshold-signed the quote (validator or PKP). */
  signer: string;
  /** Hex signature over `digest` (EIP-191 / PKP ECDSA). Empty for local stub. */
  signature: string;
  /** ISO timestamp of attestation. */
  issuedAt: string;
  /** Free-form provider metadata (e.g. Lit network, Nitro quote ref). */
  meta?: Record<string, string>;
}

export interface AttestationProvider {
  readonly mode: TeeMode;
  readonly proofKind: AttestationProofKind;
  attest(job: InferenceJob): Promise<AttestationQuote>;
}

// ---------------------------------------------------------------------------
// Shared digest helpers
// ---------------------------------------------------------------------------

export function hashUtf8(value: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

/** Bind input + output + model into a single 32-byte digest (the dataHash). */
export function computeDigest(inputHash: string, outputHash: string, modelId: string): string {
  return ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32", "string"],
    [inputHash, outputHash, modelId],
  );
}

function baseQuote(job: InferenceJob, mode: TeeMode): Omit<AttestationQuote, "signer" | "signature"> {
  const inputHash = hashUtf8(job.input);
  const outputHash = hashUtf8(job.output);
  const digest = computeDigest(inputHash, outputHash, job.modelId);
  return {
    version: ATTESTATION_VERSION,
    mode,
    proofKind: proofKindForMode(mode),
    inputHash,
    outputHash,
    digest,
    modelId: job.modelId,
    issuedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// LocalProvider — $0 dev stub, no key, no chain
// ---------------------------------------------------------------------------

export class LocalProvider implements AttestationProvider {
  readonly mode = "local" as const;
  readonly proofKind = proofKindForMode("local");

  async attest(job: InferenceJob): Promise<AttestationQuote> {
    const base = baseQuote(job, this.mode);
    logger.info(`local attestation digest=${base.digest}`);
    return {
      ...base,
      signer: ethers.ZeroAddress,
      signature: "",
      meta: { note: "local dev stub — not verifiable on-chain" },
    };
  }
}

// ---------------------------------------------------------------------------
// OptimisticProvider — validator wallet signs the digest (raw ECDSA), ~$0
// ---------------------------------------------------------------------------

export class OptimisticProvider implements AttestationProvider {
  readonly mode = "optimistic" as const;
  readonly proofKind = proofKindForMode("optimistic");

  constructor(private readonly wallet: ethers.Wallet) {}

  async attest(job: InferenceJob): Promise<AttestationQuote> {
    const base = baseQuote(job, this.mode);
    // Raw ECDSA over the 32-byte digest (no EIP-191 prefix): the digest is
    // already a keccak hash, and the on-chain OptimisticStaking contract feeds
    // it straight to the ecrecover precompile. `serialized` is 65-byte r‖s‖v.
    const signature = this.wallet.signingKey.sign(ethers.getBytes(base.digest)).serialized;
    logger.info(`optimistic attestation digest=${base.digest} signer=${this.wallet.address}`);
    return {
      ...base,
      signer: this.wallet.address,
      signature,
      meta: { scheme: "raw-ecdsa-digest" },
    };
  }
}

// ---------------------------------------------------------------------------
// LitProvider — Lit Action + PKP threshold signature (gated on config)
// ---------------------------------------------------------------------------

export class LitProvider implements AttestationProvider {
  readonly mode = "lit" as const;
  readonly proofKind = proofKindForMode("lit");

  async attest(job: InferenceJob): Promise<AttestationQuote> {
    const cfg = resolveLitConfig();
    if (!cfg) {
      throw new Error(
        "lit provider not configured — set JOY_LIT_NETWORK and JOY_LIT_PKP_PUBKEY " +
          "(and optionally JOY_LIT_ACTION_CID) to enable PKP attestation.",
      );
    }
    // Lit SDK is loaded lazily so the dependency is only required when this
    // provider is actually selected (keeps the local/optimistic path light).
    let LitNodeClientClass: unknown;
    try {
      const mod: unknown = await import(
        /* @vite-ignore */ "@lit-protocol/lit-node-client"
      );
      LitNodeClientClass = (mod as { LitNodeClient?: unknown }).LitNodeClient;
    } catch {
      throw new Error(
        "lit provider selected but @lit-protocol/lit-node-client is not installed. " +
          "Run `npm i @lit-protocol/lit-node-client` to enable it.",
      );
    }
    if (typeof LitNodeClientClass !== "function") {
      throw new Error("@lit-protocol/lit-node-client did not export LitNodeClient");
    }

    const base = baseQuote(job, this.mode);
    const Ctor = LitNodeClientClass as new (opts: { litNetwork: string }) => {
      connect(): Promise<void>;
      executeJs(args: {
        code?: string;
        ipfsId?: string;
        jsParams: Record<string, unknown>;
      }): Promise<{ signatures?: Record<string, { signature?: string; publicKey?: string }> }>;
      disconnect?(): Promise<void>;
    };

    const client = new Ctor({ litNetwork: cfg.network });
    await client.connect();
    try {
      // The Lit Action threshold-signs the digest with the PKP. When no action
      // CID is provided, an inline action performs a bare PKP ECDSA sign.
      const inlineAction = `
        const sigShare = await Lit.Actions.signEcdsa({
          toSign: ethers.utils.arrayify(digest),
          publicKey,
          sigName: "attestation",
        });
      `;
      const res = await client.executeJs({
        ...(cfg.actionCid ? { ipfsId: cfg.actionCid } : { code: inlineAction }),
        jsParams: { digest: base.digest, publicKey: cfg.pkpPublicKey },
      });
      const sig = res.signatures?.attestation;
      if (!sig?.signature) {
        throw new Error("Lit Action returned no attestation signature");
      }
      const signer = sig.publicKey
        ? ethers.computeAddress("0x" + sig.publicKey.replace(/^0x/, ""))
        : ethers.ZeroAddress;
      logger.info(`lit attestation digest=${base.digest} network=${cfg.network}`);
      return {
        ...base,
        signer,
        signature: sig.signature.startsWith("0x") ? sig.signature : `0x${sig.signature}`,
        meta: { litNetwork: cfg.network, pkpPublicKey: cfg.pkpPublicKey },
      };
    } finally {
      await client.disconnect?.();
    }
  }
}

// ---------------------------------------------------------------------------
// NitroProvider — hardware TEE quote via attestation gateway (gated on config)
// ---------------------------------------------------------------------------

export class NitroProvider implements AttestationProvider {
  readonly mode = "nitro" as const;
  readonly proofKind = proofKindForMode("nitro");

  async attest(job: InferenceJob): Promise<AttestationQuote> {
    const cfg = resolveNitroConfig();
    if (!cfg) {
      throw new Error(
        "nitro provider not configured — set JOY_NITRO_ENDPOINT (and optionally " +
          "JOY_NITRO_API_KEY) to enable hardware TEE attestation.",
      );
    }
    const base = baseQuote(job, this.mode);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

    const resp = await fetch(`${cfg.endpoint.replace(/\/$/, "")}/attest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ digest: base.digest, modelId: job.modelId }),
    });
    if (!resp.ok) {
      throw new Error(`nitro gateway returned ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as {
      signature?: string;
      signer?: string;
      quote?: string;
    };
    if (!data.signature) throw new Error("nitro gateway returned no signature");
    logger.info(`nitro attestation digest=${base.digest}`);
    return {
      ...base,
      signer: data.signer ?? ethers.ZeroAddress,
      signature: data.signature,
      meta: data.quote ? { quote: data.quote } : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the attestation provider for a mode. The optimistic provider needs a
 * signing wallet; the others are self-contained (or gated on env config).
 */
export function makeAttestationProvider(
  mode: TeeMode,
  wallet?: ethers.Wallet,
): AttestationProvider {
  switch (mode) {
    case "local":
      return new LocalProvider();
    case "optimistic":
      if (!wallet) throw new Error("optimistic provider requires a signing wallet");
      return new OptimisticProvider(wallet);
    case "lit":
      return new LitProvider();
    case "nitro":
      return new NitroProvider();
    default:
      throw new Error(`unknown TEE mode: ${String(mode)}`);
  }
}
