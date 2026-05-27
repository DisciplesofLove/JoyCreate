/**
 * Agent Memory IPC Handlers
 * Connect renderer to the agent memory engine (long-term + short-term)
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { dialog, BrowserWindow } from "electron";
import {
  getMemoryConfig,
  upsertMemoryConfig,
  createLongTermMemory,
  getLongTermMemory,
  listLongTermMemories,
  updateLongTermMemory,
  deleteLongTermMemory,
  searchLongTermMemories,
  setShortTermMemory,
  getShortTermMemories,
  deleteShortTermMemory,
  clearShortTermMemory,
  ingestConversationTurn,
  ingestMarkdownFile,
  ingestMarkdownDirectory,
} from "../../lib/agent_memory_engine";
import type { LongTermMemoryCategory as _LTCategory } from "../../types/agent_memory";
import type {
  LongTermMemoryCategory,
  ShortTermMemoryKind,
  UpsertAgentMemoryConfigRequest,
  CreateLongTermMemoryRequest,
  UpdateLongTermMemoryRequest,
  SearchLongTermMemoryRequest,
  SetShortTermMemoryRequest,
  GetShortTermMemoriesRequest,
  DeleteShortTermMemoryRequest,
  ClearShortTermMemoryRequest,
} from "../../types/agent_memory";

const logger = log.scope("agent_memory_handlers");
const handle = createLoggedHandler(logger);

export function registerAgentMemoryHandlers(): void {
  logger.info("Registering Agent Memory IPC handlers");

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------

  handle(
    "agent-memory:config:get",
    async (_event, agentId: number) => {
      return getMemoryConfig(agentId);
    },
  );

  handle(
    "agent-memory:config:upsert",
    async (_event, params: UpsertAgentMemoryConfigRequest) => {
      return upsertMemoryConfig(params);
    },
  );

  // ---------------------------------------------------------------------------
  // LONG-TERM MEMORY
  // ---------------------------------------------------------------------------

  handle(
    "agent-memory:ltm:create",
    async (_event, params: CreateLongTermMemoryRequest) => {
      return createLongTermMemory(params);
    },
  );

  handle(
    "agent-memory:ltm:get",
    async (_event, id: number) => {
      return getLongTermMemory(id);
    },
  );

  handle(
    "agent-memory:ltm:list",
    async (
      _event,
      agentId: number,
      category?: LongTermMemoryCategory,
    ) => {
      return listLongTermMemories(agentId, category);
    },
  );

  handle(
    "agent-memory:ltm:update",
    async (_event, params: UpdateLongTermMemoryRequest) => {
      const { id, ...updates } = params;
      return updateLongTermMemory(id, updates);
    },
  );

  handle(
    "agent-memory:ltm:delete",
    async (_event, id: number) => {
      await deleteLongTermMemory(id);
    },
  );

  handle(
    "agent-memory:ltm:search",
    async (_event, params: SearchLongTermMemoryRequest) => {
      return searchLongTermMemories(params);
    },
  );

  // ---------------------------------------------------------------------------
  // SHORT-TERM MEMORY
  // ---------------------------------------------------------------------------

  handle(
    "agent-memory:stm:set",
    async (_event, params: SetShortTermMemoryRequest) => {
      return setShortTermMemory(params);
    },
  );

  handle(
    "agent-memory:stm:list",
    async (_event, params: GetShortTermMemoriesRequest) => {
      return getShortTermMemories(params.agentId, params.chatId);
    },
  );

  handle(
    "agent-memory:stm:delete",
    async (_event, params: DeleteShortTermMemoryRequest) => {
      await deleteShortTermMemory(params.agentId, params.chatId, params.key);
    },
  );

  handle(
    "agent-memory:stm:clear",
    async (_event, params: ClearShortTermMemoryRequest) => {
      await clearShortTermMemory(params.agentId, params.chatId);
    },
  );

  // ---------------------------------------------------------------------------
  // CONVERSATION + MARKDOWN INGESTION
  // (lets the agent recall past chats and external .md notes)
  // ---------------------------------------------------------------------------

  handle(
    "agent-memory:ingest-conversation-turn",
    async (
      _event,
      params: {
        agentId: number;
        chatId: string | number;
        role: "user" | "assistant" | "system";
        content: string;
        turnIdx: number;
        importance?: number;
      },
    ) => {
      return ingestConversationTurn(params);
    },
  );

  handle(
    "agent-memory:ingest-markdown-file",
    async (
      _event,
      params: {
        agentId: number;
        filePath: string;
        importance?: number;
      },
    ) => {
      return ingestMarkdownFile(params);
    },
  );

  handle(
    "agent-memory:ingest-markdown-directory",
    async (
      _event,
      params: {
        agentId: number;
        dirPath: string;
        recursive?: boolean;
        importance?: number;
      },
    ) => {
      return ingestMarkdownDirectory(params);
    },
  );

  handle(
    "agent-memory:pick-and-ingest-markdown",
    async (event, params: { agentId: number; importance?: number }) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showOpenDialog(win!, {
        title: "Import Markdown into Agent Memory",
        properties: ["openFile", "openDirectory", "multiSelections"],
        filters: [
          { name: "Markdown", extensions: ["md", "markdown"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { ingested: [], failed: [] };
      }

      const fs = await import("node:fs/promises");
      const ingested: Awaited<ReturnType<typeof ingestMarkdownFile>>[] = [];
      const failed: Array<{ filePath: string; error: string }> = [];

      for (const p of result.filePaths) {
        try {
          const stat = await fs.stat(p);
          if (stat.isDirectory()) {
            const dirResult = await ingestMarkdownDirectory({
              agentId: params.agentId,
              dirPath: p,
              recursive: true,
              importance: params.importance,
            });
            ingested.push(...dirResult.ingested);
            failed.push(...dirResult.failed);
          } else {
            const fileResult = await ingestMarkdownFile({
              agentId: params.agentId,
              filePath: p,
              importance: params.importance,
            });
            ingested.push(fileResult);
          }
        } catch (err) {
          failed.push({
            filePath: p,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { ingested, failed };
    },
  );
}
