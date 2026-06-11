import { BigInt, Bytes } from "@graphprotocol/graph-ts";

import {
  AgentRegistered,
  AgentUpdated,
} from "../generated/IdentityRegistry/IdentityRegistry";
import { FeedbackSubmitted } from "../generated/ReputationRegistry/ReputationRegistry";
import {
  StoreRegistered,
  StoreAgentUpdated,
  StoreTransferred,
} from "../generated/StoreRegistry/StoreRegistry";
import {
  DropCreated,
  DropActivated,
  Minted,
} from "../generated/EditionController/EditionController";
import {
  MandateCreated,
  MandateSpent,
  MandateRevoked,
} from "../generated/AgentMandate/AgentMandate";
import { Agent, Drop, Feedback, Mandate, Mint, Store } from "../generated/schema";

// --- helpers ---------------------------------------------------------------

function decodeUtf8(value: Bytes): string {
  // Stylus emits UTF-8 byte strings for slugs/domains; fall back to hex.
  const text = value.toString();
  return text.length > 0 ? text : value.toHexString();
}

function loadOrCreateAgent(agentId: string, timestamp: BigInt): Agent {
  let agent = Agent.load(agentId);
  if (agent == null) {
    agent = new Agent(agentId);
    agent.agentAddress = Bytes.empty();
    agent.domainHash = Bytes.empty();
    agent.agentDomain = "";
    agent.reputationScore = BigInt.zero();
    agent.feedbackCount = 0;
    agent.createdAt = timestamp;
  }
  agent.updatedAt = timestamp;
  return agent as Agent;
}

// --- IdentityRegistry ------------------------------------------------------

export function handleAgentRegistered(event: AgentRegistered): void {
  const agent = loadOrCreateAgent(
    event.params.agentId.toString(),
    event.block.timestamp,
  );
  agent.agentAddress = event.params.agentAddress;
  agent.domainHash = event.params.domainHash;
  agent.agentDomain = decodeUtf8(event.params.agentDomain);
  agent.save();
}

export function handleAgentUpdated(event: AgentUpdated): void {
  const agent = loadOrCreateAgent(
    event.params.agentId.toString(),
    event.block.timestamp,
  );
  agent.agentAddress = event.params.agentAddress;
  agent.domainHash = event.params.domainHash;
  agent.agentDomain = decodeUtf8(event.params.agentDomain);
  agent.save();
}

// --- ReputationRegistry ----------------------------------------------------

export function handleFeedbackSubmitted(event: FeedbackSubmitted): void {
  const id =
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const feedback = new Feedback(id);
  feedback.clientId = event.params.clientId;
  feedback.serverId = event.params.serverId;
  feedback.score = event.params.score;
  feedback.feedbackUri = decodeUtf8(event.params.feedbackUri);
  feedback.txHash = event.transaction.hash;
  feedback.timestamp = event.block.timestamp;

  const serverId = event.params.serverId.toString();
  const agent = Agent.load(serverId);
  if (agent != null) {
    feedback.agent = serverId;
    agent.reputationScore = agent.reputationScore.plus(event.params.score);
    agent.feedbackCount = agent.feedbackCount + 1;
    agent.updatedAt = event.block.timestamp;
    agent.save();
  }
  feedback.save();
}

// --- StoreRegistry ---------------------------------------------------------

export function handleStoreRegistered(event: StoreRegistered): void {
  const id = event.params.storeId.toString();
  let storeEntity = Store.load(id);
  if (storeEntity == null) {
    storeEntity = new Store(id);
    storeEntity.createdAt = event.block.timestamp;
  }
  storeEntity.owner = event.params.owner;
  storeEntity.agentId = event.params.agentId;
  storeEntity.slugHash = event.params.slugHash;
  storeEntity.slug = decodeUtf8(event.params.slug);
  storeEntity.updatedAt = event.block.timestamp;

  if (event.params.agentId.gt(BigInt.zero())) {
    const agentId = event.params.agentId.toString();
    storeEntity.agent = agentId;
    const agent = Agent.load(agentId);
    if (agent != null) {
      agent.store = id;
      agent.updatedAt = event.block.timestamp;
      agent.save();
    }
  }
  storeEntity.save();
}

export function handleStoreAgentUpdated(event: StoreAgentUpdated): void {
  const id = event.params.storeId.toString();
  const storeEntity = Store.load(id);
  if (storeEntity == null) return;
  storeEntity.agentId = event.params.agentId;
  storeEntity.agent =
    event.params.agentId.gt(BigInt.zero())
      ? event.params.agentId.toString()
      : null;
  storeEntity.updatedAt = event.block.timestamp;
  storeEntity.save();
}

export function handleStoreTransferred(event: StoreTransferred): void {
  const id = event.params.storeId.toString();
  const storeEntity = Store.load(id);
  if (storeEntity == null) return;
  storeEntity.owner = event.params.to;
  storeEntity.updatedAt = event.block.timestamp;
  storeEntity.save();
}

// --- EditionController ------------------------------------------------------

export function handleDropCreated(event: DropCreated): void {
  const id = event.params.dropId.toString();
  let drop = Drop.load(id);
  if (drop == null) {
    drop = new Drop(id);
    drop.minted = BigInt.zero();
    drop.createdAt = event.block.timestamp;
  }
  drop.creator = event.params.creator;
  drop.store = event.params.storeId.toString();
  drop.assetLeaf = event.params.assetLeaf;
  drop.price = event.params.price;
  drop.maxSupply = event.params.maxSupply;
  drop.requiresProof = event.params.requiresProof;
  drop.active = true;
  drop.updatedAt = event.block.timestamp;
  drop.save();
}

export function handleDropActivated(event: DropActivated): void {
  const id = event.params.dropId.toString();
  const drop = Drop.load(id);
  if (drop == null) return;
  drop.active = event.params.active;
  drop.updatedAt = event.block.timestamp;
  drop.save();
}

export function handleMinted(event: Minted): void {
  const dropId = event.params.dropId.toString();
  const id =
    event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const mint = new Mint(id);
  mint.drop = dropId;
  mint.tokenId = event.params.tokenId;
  mint.to = event.params.to;
  mint.price = event.params.price;
  mint.txHash = event.transaction.hash;
  mint.blockNumber = event.block.number;
  mint.timestamp = event.block.timestamp;
  mint.save();

  const drop = Drop.load(dropId);
  if (drop != null) {
    drop.minted = drop.minted.plus(BigInt.fromI32(1));
    drop.updatedAt = event.block.timestamp;
    drop.save();
  }
}

// --- AgentMandate -----------------------------------------------------------

export function handleMandateCreated(event: MandateCreated): void {
  const id = event.params.mandateId.toString();
  const mandate = new Mandate(id);
  mandate.principal = event.params.principal;
  mandate.agent = event.params.agent;
  mandate.spendLimit = event.params.spendLimit;
  mandate.totalSpent = BigInt.zero();
  mandate.expiry = event.params.expiry;
  mandate.actionScope = event.params.actionScope;
  mandate.active = true;
  mandate.createdAt = event.block.timestamp;
  mandate.updatedAt = event.block.timestamp;
  mandate.save();
}

export function handleMandateSpent(event: MandateSpent): void {
  const id = event.params.mandateId.toString();
  const mandate = Mandate.load(id);
  if (mandate == null) return;
  mandate.totalSpent = event.params.totalSpent;
  mandate.updatedAt = event.block.timestamp;
  mandate.save();
}

export function handleMandateRevoked(event: MandateRevoked): void {
  const id = event.params.mandateId.toString();
  const mandate = Mandate.load(id);
  if (mandate == null) return;
  mandate.active = false;
  mandate.updatedAt = event.block.timestamp;
  mandate.save();
}
