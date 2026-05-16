/**
 * DropERC1155 on-chain listener.
 *
 * Subscribes to ERC-1155 transfers from the platform DropERC1155 contract
 * on Polygon Amoy and translates them into domain events. Idempotent:
 * every observed (txHash, logIndex) pair is recorded in `on_chain_drop_events`
 * before publish, so reconnects do NOT double-publish.
 *
 * Lifecycle:
 *   start()  — boot, attach provider listener, exponential-backoff reconnect
 *   stop()   — detach
 *   replay(fromBlock) — manual catch-up over a historical block range
 */

import { ethers } from "ethers";
import log from "electron-log";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { onChainDropEvents } from "@/db/schema";
import { getDomainEventBus } from "@/lib/events/domain_event_bus";
import {
  DEFAULT_MARKETPLACE_CHAIN,
  getMarketplaceChain,
  isMarketplaceChainId,
  isMarketplaceChainReady,
  type MarketplaceChainConfig,
  type MarketplaceChainId,
} from "@/lib/onchain/chain_registry";
import { readSettings } from "@/main/settings";

const logger = log.scope("drop_event_listener");

// Polygon Amoy (thirdweb DropERC1155) ABI surface — used when the resolved
// chain is `polygonAmoy`. Arbitrum Stylus chains pull their ABI from
// chain_registry (STYLUS_DROP_ABI) and only emit TransferSingle.
const DROP_ABI = [
  "event TokensClaimed(uint256 indexed claimConditionIndex, address indexed claimer, address indexed receiver, uint256 tokenId, uint256 quantityClaimed)",
  "event TokensLazyMinted(uint256 startTokenId, uint256 endTokenId, string baseURI, bytes encryptedBaseURI)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
];

type ListenerStatus = "stopped" | "starting" | "running" | "reconnecting" | "error";

const ZERO_ADDR_LC = "0x0000000000000000000000000000000000000000";

function resolveActiveChain(): MarketplaceChainConfig {
  let id: MarketplaceChainId = DEFAULT_MARKETPLACE_CHAIN;
  try {
    const settings = readSettings();
    const candidate = (settings as { marketplaceChain?: string }).marketplaceChain;
    if (isMarketplaceChainId(candidate)) id = candidate;
  } catch {
    // settings unavailable (e.g. in tests) — fall back to default
  }
  return getMarketplaceChain(id);
}

class DropEventListener {
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;
  private status: ListenerStatus = "stopped";
  private lastError: string | null = null;
  private reconnectMs = 2_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private activeChain: MarketplaceChainConfig = getMarketplaceChain(DEFAULT_MARKETPLACE_CHAIN);

  getStatus(): {
    status: ListenerStatus;
    lastError: string | null;
    contract: string;
    chainId: number;
    chainName: string;
    marketplaceChain: MarketplaceChainId;
  } {
    return {
      status: this.status,
      lastError: this.lastError,
      contract: this.activeChain.contracts.dropEdition,
      chainId: this.activeChain.chain.chainId,
      chainName: this.activeChain.chain.name,
      marketplaceChain: this.activeChain.id,
    };
  }

  async start(): Promise<void> {
    if (this.status === "running" || this.status === "starting") return;
    this.status = "starting";
    try {
      this.activeChain = resolveActiveChain();

      if (!isMarketplaceChainReady(this.activeChain.id)) {
        this.status = "error";
        this.lastError = `Marketplace chain ${this.activeChain.id} has no deployed dropEdition contract — refusing to start listener.`;
        logger.warn(this.lastError);
        return;
      }

      const { chain, contracts } = this.activeChain;
      const abi = this.activeChain.id === "polygonAmoy" ? DROP_ABI : [...this.activeChain.abi];

      this.provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
      this.contract = new ethers.Contract(contracts.dropEdition, abi, this.provider);

      if (this.activeChain.id === "polygonAmoy") {
        // thirdweb DropERC1155 emits a dedicated TokensClaimed event.
        this.contract.on(
          "TokensClaimed",
          (_idx, _claimer, receiver, tokenId, quantityClaimed, ev) => {
            void this.handleClaimed({
              receiver: String(receiver),
              tokenId: tokenId.toString(),
              quantityClaimed: quantityClaimed.toString(),
              txHash: ev.log.transactionHash,
              logIndex: ev.log.index,
              blockNumber: ev.log.blockNumber,
              eventName: "TokensClaimed",
            });
          },
        );
      } else {
        // OpenZeppelin Stylus Erc1155 only emits TransferSingle/Batch — treat
        // mints (from == 0x0) as the claim signal.
        this.contract.on(
          "TransferSingle",
          (_operator, from, to, id, value, ev) => {
            if (String(from).toLowerCase() !== ZERO_ADDR_LC) return;
            void this.handleClaimed({
              receiver: String(to),
              tokenId: id.toString(),
              quantityClaimed: value.toString(),
              txHash: ev.log.transactionHash,
              logIndex: ev.log.index,
              blockNumber: ev.log.blockNumber,
              eventName: "TransferSingle",
            });
          },
        );
      }

      this.provider.on("error", (err) => {
        this.lastError = (err as Error)?.message ?? String(err);
        logger.warn("provider error", err);
        this.scheduleReconnect();
      });

      this.status = "running";
      this.reconnectMs = 2_000;
      this.lastError = null;
      logger.info("drop event listener running", {
        chain: this.activeChain.id,
        chainId: chain.chainId,
        contract: contracts.dropEdition,
      });
    } catch (err) {
      this.status = "error";
      this.lastError = (err as Error).message;
      logger.error("failed to start", err);
      this.scheduleReconnect();
    }
  }

  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.contract) this.contract.removeAllListeners();
    if (this.provider) this.provider.removeAllListeners();
    this.contract = null;
    this.provider = null;
    this.status = "stopped";
  }

  /**
   * Replay TokensClaimed (Polygon Amoy) or TransferSingle mints (Arbitrum)
   * in [fromBlock, latest]. Idempotent — events already present in
   * `on_chain_drop_events` are skipped.
   */
  async replaySince(fromBlock: number): Promise<{ replayed: number }> {
    const active = resolveActiveChain();
    if (!isMarketplaceChainReady(active.id)) return { replayed: 0 };
    const abi = active.id === "polygonAmoy" ? DROP_ABI : [...active.abi];
    const provider = new ethers.JsonRpcProvider(active.chain.rpcUrl, active.chain.chainId);
    const contract = new ethers.Contract(active.contracts.dropEdition, abi, provider);
    const latest = await provider.getBlockNumber();
    const filter =
      active.id === "polygonAmoy"
        ? contract.filters.TokensClaimed()
        : contract.filters.TransferSingle();
    const events = await contract.queryFilter(filter, fromBlock, latest);
    let replayed = 0;
    for (const ev of events) {
      const args = (ev as ethers.EventLog).args;
      if (!args) continue;
      let payload: Parameters<DropEventListener["handleClaimed"]>[0];
      if (active.id === "polygonAmoy") {
        // (idx, claimer, receiver, tokenId, quantity)
        payload = {
          receiver: String(args[2]),
          tokenId: args[3].toString(),
          quantityClaimed: args[4].toString(),
          txHash: ev.transactionHash,
          logIndex: ev.index,
          blockNumber: ev.blockNumber,
          eventName: "TokensClaimed",
          contractOverride: active.contracts.dropEdition,
        };
      } else {
        // (operator, from, to, id, value)
        if (String(args[1]).toLowerCase() !== ZERO_ADDR_LC) continue;
        payload = {
          receiver: String(args[2]),
          tokenId: args[3].toString(),
          quantityClaimed: args[4].toString(),
          txHash: ev.transactionHash,
          logIndex: ev.index,
          blockNumber: ev.blockNumber,
          eventName: "TransferSingle",
          contractOverride: active.contracts.dropEdition,
        };
      }
      const ok = await this.handleClaimed(payload);
      if (ok) replayed += 1;
    }
    return { replayed };
  }

  private scheduleReconnect(): void {
    this.status = "reconnecting";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      void this.start();
    }, this.reconnectMs);
    this.reconnectMs = Math.min(this.reconnectMs * 2, 60_000);
  }

  private async handleClaimed(args: {
    receiver: string;
    tokenId: string;
    quantityClaimed: string;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    eventName: "TokensClaimed" | "TransferSingle";
    contractOverride?: string;
  }): Promise<boolean> {
    const contractAddress = args.contractOverride ?? this.activeChain.contracts.dropEdition;
    // Idempotency check.
    const existing = await db
      .select({ id: onChainDropEvents.id })
      .from(onChainDropEvents)
      .where(
        and(
          eq(onChainDropEvents.txHash, args.txHash),
          eq(onChainDropEvents.logIndex, args.logIndex),
        ),
      )
      .limit(1);
    if (existing.length > 0) return false;

    await db.insert(onChainDropEvents).values({
      eventName: args.eventName,
      contractAddress,
      txHash: args.txHash,
      logIndex: args.logIndex,
      blockNumber: args.blockNumber,
      argsJson: { ...args },
    });

    await getDomainEventBus().publish(
      "asset.claimed",
      {
        contractAddress,
        tokenId: args.tokenId,
        buyerAddress: args.receiver.toLowerCase(),
        amountUnits: args.quantityClaimed,
        txHash: args.txHash,
        blockNumber: args.blockNumber,
      },
      { sourceTxHash: args.txHash, sourceLogIndex: args.logIndex },
    );
    return true;
  }
}

let singleton: DropEventListener | null = null;

export function getDropEventListener(): DropEventListener {
  if (!singleton) singleton = new DropEventListener();
  return singleton;
}
