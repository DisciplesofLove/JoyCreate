/**
 * Agent Card — the IPLD runtime manifest bound to an ERC-8004 identity.
 *
 * An agent card is a small JSON document, pinned to IPFS, that describes a
 * marketplace resource (a store, an edition, or an agent) and — crucially —
 * carries the *runtime* fields a consumer needs to execute it locally:
 * `modelConfig`, `systemPrompt`, `toolsSchema`, and `skillCID`. The resulting
 * CID is stored as the ERC-8004 `agentDomain`, so resolving an identity yields
 * a pointer to its runtime manifest.
 *
 * This is the "best of both": the brief's agent-card-as-runtime-manifest shape
 * fused with JoyCreate's deployed Identity Registry + multi-provider pinner.
 *
 * `ensureStoreIdentity` is the LR1 composition entry point: it reuses an
 * existing identity for the wallet when one is already registered, otherwise it
 * builds + pins a card and mints a fresh ERC-8004 identity whose `agentDomain`
 * is the card CID.
 */

import log from "electron-log";
import { ethers } from "ethers";

import { ERC8004_CHAIN_IDS, type Erc8004ChainId } from "@/config/erc8004";
import { registerAgent, resolveByAddress } from "@/lib/onchain/erc8004_client";
import {
  IpfsPinner,
  loadPinnerKeysFromSettings,
  type PinnerKeys,
} from "@/lib/joymarketplace/ipfs_pinner";

const logger = log.scope("agent_card");

/** Platform name embedded in every card emitted by this build. */
export const AGENT_CARD_PLATFORM = "JoyCreate";

/** Current agent-card schema version. */
export const AGENT_CARD_VERSION = "1.0";

export type AgentCardType = "store" | "edition" | "agent";

/** Runtime manifest fields (nullable until a runtime is configured). */
export interface AgentCardRuntime {
  /** Local/remote model configuration descriptor. */
  modelConfig: Record<string, unknown> | null;
  /** System prompt that seeds the agent's behaviour. */
  systemPrompt: string | null;
  /** JSON schema describing the tools the agent may invoke. */
  toolsSchema: Record<string, unknown> | null;
  /** IPFS CID of an executable skill bundle (Phase 2 local execution). */
  skillCID: string | null;
}

export interface AgentCard extends AgentCardRuntime {
  name: string;
  version: string;
  platform: string;
  type: AgentCardType;
  identity: {
    storeLabel: string;
    owner: string;
  };
  chainId: number;
}

export interface BuildAgentCardInput {
  /** Human-readable name / store slug. */
  name: string;
  /** Card kind. Default "store". */
  type?: AgentCardType;
  /** Controlling/owner address. */
  owner: string;
  /** Chain the bound identity lives on. */
  chain: Erc8004ChainId;
  /** Optional runtime manifest overrides. All default to null. */
  runtime?: Partial<AgentCardRuntime>;
}

/** Build a minimal agent card document (pure — no I/O). */
export function buildAgentCard(input: BuildAgentCardInput): AgentCard {
  const runtime = input.runtime ?? {};
  return {
    name: input.name,
    version: AGENT_CARD_VERSION,
    platform: AGENT_CARD_PLATFORM,
    type: input.type ?? "store",
    modelConfig: runtime.modelConfig ?? null,
    systemPrompt: runtime.systemPrompt ?? null,
    toolsSchema: runtime.toolsSchema ?? null,
    skillCID: runtime.skillCID ?? null,
    identity: {
      storeLabel: input.name,
      owner: input.owner,
    },
    chainId: ERC8004_CHAIN_IDS[input.chain],
  };
}

export interface PinAgentCardResult {
  cid: string;
  uri: string;
  pinnedRemotely: boolean;
}

/** Pin an agent card to IPFS via the multi-provider pinner. */
export async function pinAgentCard(
  card: AgentCard,
  opts: { keys?: PinnerKeys } = {},
): Promise<PinAgentCardResult> {
  const keys = opts.keys ?? (await loadPinnerKeysFromSettings());
  const pinner = new IpfsPinner({ keys });
  const result = await pinner.pinJson(card, `${card.name}-agent-card`);
  if (!result.pinnedRemotely) {
    logger.warn(
      `agent card for "${card.name}" pinned only via local Helia — not retrievable from public gateways`,
    );
  }
  return { cid: result.cid, uri: `ipfs://${result.cid}`, pinnedRemotely: result.pinnedRemotely };
}

export interface EnsureStoreIdentityInput {
  /** Identity chain. */
  chain: Erc8004ChainId;
  /** Store slug / human name embedded in the card. */
  slug: string;
  /** Card kind. Default "store". */
  type?: AgentCardType;
  /** Optional runtime manifest overrides. */
  runtime?: Partial<AgentCardRuntime>;
  /** Pre-loaded pinner keys (avoids re-reading settings). */
  pinnerKeys?: PinnerKeys;
}

export interface EnsureStoreIdentityResult {
  /** ERC-8004 agent id ("0" only when minting was skipped). */
  agentId: string;
  /** Agent-card CID when a card was pinned this call. */
  agentCardCid?: string;
  agentCardUri?: string;
  /** True when a new identity was minted. */
  minted: boolean;
  /** True when an existing identity for the wallet was reused. */
  reused: boolean;
  txHash?: string;
}

/**
 * Resolve — or mint — the ERC-8004 identity for a store wallet.
 *
 * Identities are keyed by controlling address: if the wallet already owns an
 * agent, it is reused (no duplicate mint, no new card). Otherwise an agent card
 * is built + pinned and a fresh identity is minted with the card CID as its
 * `agentDomain`.
 */
export async function ensureStoreIdentity(
  wallet: ethers.Wallet,
  input: EnsureStoreIdentityInput,
): Promise<EnsureStoreIdentityResult> {
  // Reuse an existing identity for this address when present.
  try {
    const existing = await resolveByAddress(input.chain, wallet.address);
    if (existing && existing !== "0") {
      logger.info(`reusing ERC-8004 identity ${existing} for ${wallet.address}`);
      return { agentId: existing, minted: false, reused: true };
    }
  } catch (err) {
    // resolveByAddress reverting / unavailable is non-fatal — attempt a mint.
    logger.warn(`resolveByAddress failed, attempting mint: ${(err as Error).message}`);
  }

  const card = buildAgentCard({
    name: input.slug,
    type: input.type ?? "store",
    owner: wallet.address,
    chain: input.chain,
    runtime: input.runtime,
  });
  const pinned = await pinAgentCard(card, { keys: input.pinnerKeys });

  const reg = await registerAgent(wallet, {
    chain: input.chain,
    agentDomain: pinned.cid,
    agentAddress: wallet.address,
  });
  logger.info(`minted ERC-8004 identity ${reg.agentId} (card ${pinned.cid})`);

  return {
    agentId: reg.agentId,
    agentCardCid: pinned.cid,
    agentCardUri: pinned.uri,
    minted: true,
    reused: false,
    txHash: reg.txHash,
  };
}

/**
 * Best-effort recognizer for an IPFS CID stored in an ERC-8004 `agentDomain`.
 * Used by the interface broker to expose a `runtime` pointer when an identity's
 * domain is a pinned agent card rather than a legacy plain-text domain.
 */
export function agentDomainToCardCid(agentDomain: string | undefined): string | undefined {
  if (!agentDomain) return undefined;
  const trimmed = agentDomain.trim().replace(/^ipfs:\/\//, "");
  // CIDv0 (Qm…, base58btc, 46 chars) or CIDv1 (bafy…/bafk…, base32).
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(trimmed)) return trimmed;
  if (/^ba[a-z2-7]{56,}$/.test(trimmed)) return trimmed;
  return undefined;
}
