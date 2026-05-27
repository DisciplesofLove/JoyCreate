/**
 * Agent Memory IPC Client — Renderer-side API for agent memory system
 */

import type {
  AgentMemoryConfig,
  LongTermMemory,
  LongTermMemoryCategory,
  ShortTermMemory,
  UpsertAgentMemoryConfigRequest,
  CreateLongTermMemoryRequest,
  UpdateLongTermMemoryRequest,
  SearchLongTermMemoryRequest,
  SetShortTermMemoryRequest,
  GetShortTermMemoriesRequest,
  DeleteShortTermMemoryRequest,
  ClearShortTermMemoryRequest,
} from "../../types/agent_memory";

export class AgentMemoryClient {
  private static instance: AgentMemoryClient;

  static getInstance(): AgentMemoryClient {
    if (!AgentMemoryClient.instance) {
      AgentMemoryClient.instance = new AgentMemoryClient();
    }
    return AgentMemoryClient.instance;
  }

  private invoke(channel: string, ...args: unknown[]): Promise<any> {
    return window.electron.ipcRenderer.invoke(channel, ...args);
  }

  // ── Config ──────────────────────────────────────────────────────

  getConfig(agentId: number): Promise<AgentMemoryConfig | null> {
    return this.invoke("agent-memory:config:get", agentId);
  }

  upsertConfig(
    params: UpsertAgentMemoryConfigRequest,
  ): Promise<AgentMemoryConfig> {
    return this.invoke("agent-memory:config:upsert", params);
  }

  // ── Long-Term Memory ───────────────────────────────────────────

  createLTM(params: CreateLongTermMemoryRequest): Promise<LongTermMemory> {
    return this.invoke("agent-memory:ltm:create", params);
  }

  getLTM(id: number): Promise<LongTermMemory | null> {
    return this.invoke("agent-memory:ltm:get", id);
  }

  listLTM(
    agentId: number,
    category?: LongTermMemoryCategory,
  ): Promise<LongTermMemory[]> {
    return this.invoke("agent-memory:ltm:list", agentId, category);
  }

  updateLTM(params: UpdateLongTermMemoryRequest): Promise<LongTermMemory | null> {
    return this.invoke("agent-memory:ltm:update", params);
  }

  deleteLTM(id: number): Promise<void> {
    return this.invoke("agent-memory:ltm:delete", id);
  }

  searchLTM(params: SearchLongTermMemoryRequest): Promise<LongTermMemory[]> {
    return this.invoke("agent-memory:ltm:search", params);
  }

  // ── Short-Term Memory ──────────────────────────────────────────

  setSTM(params: SetShortTermMemoryRequest): Promise<ShortTermMemory> {
    return this.invoke("agent-memory:stm:set", params);
  }

  listSTM(params: GetShortTermMemoriesRequest): Promise<ShortTermMemory[]> {
    return this.invoke("agent-memory:stm:list", params);
  }

  deleteSTM(params: DeleteShortTermMemoryRequest): Promise<void> {
    return this.invoke("agent-memory:stm:delete", params);
  }

  clearSTM(params: ClearShortTermMemoryRequest): Promise<void> {
    return this.invoke("agent-memory:stm:clear", params);
  }

  // ── Ingestion (conversations + markdown) ───────────────────────

  ingestConversationTurn(params: {
    agentId: number;
    chatId: string | number;
    role: "user" | "assistant" | "system";
    content: string;
    turnIdx: number;
    importance?: number;
  }): Promise<LongTermMemory | null> {
    return this.invoke("agent-memory:ingest-conversation-turn", params);
  }

  ingestMarkdownFile(params: {
    agentId: number;
    filePath: string;
    importance?: number;
  }): Promise<{ filePath: string; memoryId: number; bytes: number }> {
    return this.invoke("agent-memory:ingest-markdown-file", params);
  }

  ingestMarkdownDirectory(params: {
    agentId: number;
    dirPath: string;
    recursive?: boolean;
    importance?: number;
  }): Promise<{
    ingested: Array<{ filePath: string; memoryId: number; bytes: number }>;
    failed: Array<{ filePath: string; error: string }>;
  }> {
    return this.invoke("agent-memory:ingest-markdown-directory", params);
  }

  pickAndIngestMarkdown(params: {
    agentId: number;
    importance?: number;
  }): Promise<{
    ingested: Array<{ filePath: string; memoryId: number; bytes: number }>;
    failed: Array<{ filePath: string; error: string }>;
  }> {
    return this.invoke("agent-memory:pick-and-ingest-markdown", params);
  }
}

export const agentMemoryClient = AgentMemoryClient.getInstance();
