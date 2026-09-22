/**
 * LR11 — Skill authoring + pinning pipeline.
 *
 * Closes the LR8/LR9/LR10 "needs a pinned bundle" gap: build a validated
 * `SkillBundle` from author-supplied fields, pin it to IPFS, write its CID into
 * the agent's card (`skillCID`), re-pin the card, and point the ERC-8004
 * `agentDomain` at the new card CID. After this runs, `resolveSkill` →
 * `invokeSkillRuntime` works end to end for the agent.
 *
 * Pinning and IPFS reads are injectable (`AuthoringDeps`) so the orchestration
 * is unit-testable without touching the network or a real pinner.
 */

import log from "electron-log";
import { ethers } from "ethers";

import type { Erc8004ChainId } from "@/config/erc8004";
import {
  agentDomainToCardCid,
  buildAgentCard,
  type AgentCard,
} from "@/lib/onchain/agent_card";
import { getAgent, updateAgent } from "@/lib/onchain/erc8004_client";
import {
  IpfsPinner,
  loadPinnerKeysFromSettings,
  type PinnerKeys,
} from "@/lib/joymarketplace/ipfs_pinner";
import { fetchIpfsJson } from "@/lib/ipfs/ipfs_fetch";
import { parseSkillBundle, SKILL_BUNDLE_SCHEMA, type SkillBundle } from "@/lib/onchain/skill_runtime";

const logger = log.scope("skill_authoring");

/** Author-supplied skill description (sans the constant `schema` field). */
export type AuthorSkillInput =
  | {
      kind: "prompt-agent";
      modelId: string;
      systemPrompt: string;
      promptTemplate?: string;
      maxTokens?: number;
      temperature?: number;
    }
  | {
      kind: "tool-agent";
      modelId: string;
      systemPrompt: string;
      tools: string[];
      maxSteps?: number;
      promptTemplate?: string;
      maxTokens?: number;
      temperature?: number;
    }
  | {
      kind: "code-agent";
      code: string;
      allowedModules?: string[];
      timeoutMs?: number;
      maxMemoryMb?: number;
    };

export interface PinResult {
  cid: string;
  pinnedRemotely: boolean;
}

/** Pin a JSON document and return its CID. Injectable for tests. */
export type PinJsonFn = (doc: unknown, name: string) => Promise<PinResult>;

export interface AuthoringDeps {
  pinJson?: PinJsonFn;
  fetchJson?: typeof fetchIpfsJson;
  pinnerKeys?: PinnerKeys;
}

/** Default pinner backed by the multi-provider IpfsPinner. */
async function defaultPinJson(keys?: PinnerKeys): Promise<PinJsonFn> {
  const resolved = keys ?? (await loadPinnerKeysFromSettings());
  const pinner = new IpfsPinner({ keys: resolved });
  return async (doc, name) => {
    const r = await pinner.pinJson(doc, name);
    return { cid: r.cid, pinnedRemotely: r.pinnedRemotely };
  };
}

/**
 * Build + validate a `SkillBundle` from author input. Pure — runs the same
 * `parseSkillBundle` validation/clamping the runtime applies to untrusted CIDs,
 * so an author can never pin a bundle the runtime would later reject.
 */
export function buildSkillBundle(input: AuthorSkillInput): SkillBundle {
  return parseSkillBundle({ schema: SKILL_BUNDLE_SCHEMA, ...input });
}

export interface AuthoredSkill {
  skillCid: string;
  skillUri: string;
  pinnedRemotely: boolean;
  bundle: SkillBundle;
}

/** Build, validate, and pin a skill bundle. */
export async function authorAndPinSkill(
  input: AuthorSkillInput,
  deps: AuthoringDeps = {},
): Promise<AuthoredSkill> {
  const bundle = buildSkillBundle(input);
  const pinJson = deps.pinJson ?? (await defaultPinJson(deps.pinnerKeys));
  const { cid, pinnedRemotely } = await pinJson(bundle, `skill-${bundle.kind}`);
  if (!pinnedRemotely) {
    logger.warn(`skill ${cid} pinned only via local Helia — not retrievable from public gateways`);
  }
  return { skillCid: cid, skillUri: `ipfs://${cid}`, pinnedRemotely, bundle };
}

export interface PublishSkillInput {
  chain: Erc8004ChainId;
  /** ERC-8004 agent id whose card the skill is attached to. */
  agentId: string;
  /** The skill to author + pin. */
  skill: AuthorSkillInput;
  /** Name for a freshly-built card when the agent has none yet. */
  cardName?: string;
}

export interface PublishSkillResult {
  agentId: string;
  skillCid: string;
  skillUri: string;
  cardCid: string;
  cardUri: string;
  txHash: string;
  pinnedRemotely: boolean;
}

/**
 * End-to-end author → pin skill → attach to card → re-pin card → update the
 * ERC-8004 `agentDomain`. Returns the new skill + card CIDs and the on-chain tx.
 */
export async function publishSkillToAgent(
  wallet: ethers.Wallet,
  input: PublishSkillInput,
  deps: AuthoringDeps = {},
): Promise<PublishSkillResult> {
  const fetchJson = deps.fetchJson ?? fetchIpfsJson;
  // Resolve a single pinner so the skill + card share one provider session.
  const pinJson = deps.pinJson ?? (await defaultPinJson(deps.pinnerKeys));

  // 1. Author + pin the skill bundle.
  const authored = await authorAndPinSkill(input.skill, { ...deps, pinJson });

  // 2. Resolve the agent + its current card (or build a fresh one).
  const agent = await getAgent(input.chain, input.agentId);
  if (agent.agentAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `wallet ${wallet.address} does not control agent ${input.agentId} (${agent.agentAddress})`,
    );
  }
  const cardCid = agentDomainToCardCid(agent.agentDomain);
  let card: AgentCard;
  if (cardCid) {
    card = await fetchJson<AgentCard>(cardCid);
    if (!card || typeof card !== "object") {
      throw new Error(`agent card ${cardCid} could not be parsed`);
    }
  } else {
    card = buildAgentCard({
      name: input.cardName ?? `agent-${input.agentId}`,
      type: "agent",
      owner: agent.agentAddress,
      chain: input.chain,
    });
  }

  // 3. Attach the skill CID and re-pin the card.
  const updatedCard: AgentCard = { ...card, skillCID: authored.skillCid };
  const { cid: newCardCid } = await pinJson(updatedCard, `${updatedCard.name}-agent-card`);

  // 4. Point the on-chain identity at the new card.
  const { txHash } = await updateAgent(wallet, {
    chain: input.chain,
    agentId: input.agentId,
    newDomain: newCardCid,
    newAddress: agent.agentAddress,
  });
  logger.info(`published skill ${authored.skillCid} to agent ${input.agentId} (card ${newCardCid})`);

  return {
    agentId: input.agentId,
    skillCid: authored.skillCid,
    skillUri: authored.skillUri,
    cardCid: newCardCid,
    cardUri: `ipfs://${newCardCid}`,
    txHash,
    pinnedRemotely: authored.pinnedRemotely,
  };
}
