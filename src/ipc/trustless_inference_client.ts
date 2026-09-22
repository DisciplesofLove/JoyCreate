/**
 * Trustless Inference IPC Client
 * Renderer-side client for trustless local AI inference with verification
 */

import type { IpcRenderer } from "electron";

import type {
  LocalModelProvider,
  LocalModelInfo,
  InferenceRecord,
  VerificationResult,
  HeliaNodeStatus,
  InferenceStats,
  InferenceMessage,
  InferenceConversation,
} from "@/types/trustless_inference";

// Type for the inference result
interface InferenceResult {
  output: string;
  recordId?: string;
  cid?: string;
  verified?: boolean;
  tokens: number;
  timeMs: number;
}

// Get typed IPC renderer
function getIpcRenderer(): IpcRenderer {
  return (window as unknown as { electron: { ipcRenderer: IpcRenderer } }).electron.ipcRenderer;
}

/**
 * Trustless Inference Client
 * Provides a clean API for verified local AI inference
 */
export class TrustlessInferenceClient {
  private static instance: TrustlessInferenceClient;
  private ipcRenderer: IpcRenderer;

  private constructor() {
    this.ipcRenderer = getIpcRenderer();
  }

  static getInstance(): TrustlessInferenceClient {
    if (!TrustlessInferenceClient.instance) {
      TrustlessInferenceClient.instance = new TrustlessInferenceClient();
    }
    return TrustlessInferenceClient.instance;
  }

  // ============================================================================
  // Service Lifecycle
  // ============================================================================

  async initialize(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("trustless:initialize");
  }

  async shutdown(): Promise<{ success: boolean }> {
    return this.ipcRenderer.invoke("trustless:shutdown");
  }

  // ============================================================================
  // Provider Management
  // ============================================================================

  async checkProviders(): Promise<Record<LocalModelProvider, boolean>> {
    return this.ipcRenderer.invoke("trustless:check-providers");
  }

  async listModels(): Promise<LocalModelInfo[]> {
    return this.ipcRenderer.invoke("trustless:list-models");
  }

  async getModelInfo(
    provider: LocalModelProvider,
    modelId: string
  ): Promise<LocalModelInfo | null> {
    return this.ipcRenderer.invoke("trustless:get-model-info", provider, modelId);
  }

  // ============================================================================
  // Verified Inference
  // ============================================================================

  async runInference(params: {
    provider: LocalModelProvider;
    modelId: string;
    prompt: string;
    systemPrompt?: string;
    messages?: InferenceMessage[];
    config?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      topK?: number;
      seed?: number;
    };
    skipVerification?: boolean;
  }): Promise<InferenceResult> {
    return this.ipcRenderer.invoke("trustless:run-inference", params);
  }

  /**
   * Stream inference tokens progressively (ChatGPT-style).
   *
   * Subscribes to the stable `trustless:stream-token|done|error` channels and
   * filters by `streamId` so multiple concurrent streams don't collide.
   * Returns an async cancel handle that removes its listeners.
   */
  async streamInference(
    params: {
      provider: LocalModelProvider;
      modelId: string;
      messages: InferenceMessage[];
      systemPrompt?: string;
      config?: {
        temperature?: number;
        maxTokens?: number;
        topP?: number;
        topK?: number;
        seed?: number;
        repeatPenalty?: number;
        numCtx?: number;
      };
    },
    callbacks: {
      onToken: (content: string) => void;
      onDone?: (data: { recordId?: string; cid?: string }) => void;
      onError?: (error: string) => void;
    }
  ): Promise<{ streamId: string; cancel: () => void }> {
    // Generate the streamId in the renderer so listeners can be attached BEFORE
    // the main process starts emitting — otherwise early token/done events fired
    // before `invoke` resolves would be lost, leaving the UI stuck "thinking".
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // NOTE: the preload `on` wrapper invokes listeners as `listener(...args)`
    // WITHOUT the IpcRendererEvent, so the payload is the FIRST argument here.
    const onToken = (payload: unknown) => {
      const p = payload as { streamId?: string; content?: string };
      if (p?.streamId === streamId && typeof p.content === "string") {
        callbacks.onToken(p.content);
      }
    };
    const onDone = (payload: unknown) => {
      const p = payload as { streamId?: string; recordId?: string; cid?: string };
      if (p?.streamId === streamId) {
        cleanup();
        callbacks.onDone?.({ recordId: p.recordId, cid: p.cid });
      }
    };
    const onError = (payload: unknown) => {
      const p = payload as { streamId?: string; error?: string };
      if (p?.streamId === streamId) {
        cleanup();
        callbacks.onError?.(p.error ?? "Stream failed");
      }
    };

    const cleanup = () => {
      this.ipcRenderer.removeListener("trustless:stream-token", onToken);
      this.ipcRenderer.removeListener("trustless:stream-done", onDone);
      this.ipcRenderer.removeListener("trustless:stream-error", onError);
    };

    this.ipcRenderer.on("trustless:stream-token", onToken);
    this.ipcRenderer.on("trustless:stream-done", onDone);
    this.ipcRenderer.on("trustless:stream-error", onError);

    try {
      await this.ipcRenderer.invoke("trustless:start-stream", { ...params, streamId });
    } catch (err) {
      cleanup();
      callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }

    return { streamId, cancel: cleanup };
  }

  /**
   * Stream a conversation turn (ChatGPT-style). Persists the user + assistant
   * messages server-side while emitting tokens live. Mirrors {@link sendMessage}
   * but streams instead of blocking until the full response is ready.
   */
  async streamMessage(
    params: {
      conversationId: string;
      message: string;
      config?: {
        temperature?: number;
        maxTokens?: number;
        topP?: number;
        topK?: number;
        seed?: number;
        repeatPenalty?: number;
        numCtx?: number;
      };
    },
    callbacks: {
      onToken: (content: string) => void;
      onDone?: (data: { recordId?: string; cid?: string }) => void;
      onError?: (error: string) => void;
    }
  ): Promise<{ streamId: string; cancel: () => void }> {
    // Renderer-generated id so listeners attach BEFORE the main process emits.
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Payload is the FIRST argument (preload strips the IpcRendererEvent).
    const onToken = (payload: unknown) => {
      const p = payload as { streamId?: string; content?: string };
      if (p?.streamId === streamId && typeof p.content === "string") {
        callbacks.onToken(p.content);
      }
    };
    const onDone = (payload: unknown) => {
      const p = payload as { streamId?: string; recordId?: string; cid?: string };
      if (p?.streamId === streamId) {
        cleanup();
        callbacks.onDone?.({ recordId: p.recordId, cid: p.cid });
      }
    };
    const onError = (payload: unknown) => {
      const p = payload as { streamId?: string; error?: string };
      if (p?.streamId === streamId) {
        cleanup();
        callbacks.onError?.(p.error ?? "Stream failed");
      }
    };

    const cleanup = () => {
      this.ipcRenderer.removeListener("trustless:stream-token", onToken);
      this.ipcRenderer.removeListener("trustless:stream-done", onDone);
      this.ipcRenderer.removeListener("trustless:stream-error", onError);
    };

    this.ipcRenderer.on("trustless:stream-token", onToken);
    this.ipcRenderer.on("trustless:stream-done", onDone);
    this.ipcRenderer.on("trustless:stream-error", onError);

    try {
      await this.ipcRenderer.invoke("trustless:stream-message", { ...params, streamId });
    } catch (err) {
      cleanup();
      callbacks.onError?.(err instanceof Error ? err.message : String(err));
    }

    return { streamId, cancel: cleanup };
  }

  // ============================================================================
  // Verification Operations
  // ============================================================================

  async verifyRecord(recordId: string): Promise<VerificationResult> {
    return this.ipcRenderer.invoke("trustless:verify-record", recordId);
  }

  async getRecord(recordId: string): Promise<InferenceRecord | null> {
    return this.ipcRenderer.invoke("trustless:get-record", recordId);
  }

  async listRecords(limit?: number): Promise<InferenceRecord[]> {
    return this.ipcRenderer.invoke("trustless:list-records", limit);
  }

  async exportProof(recordId: string): Promise<string> {
    return this.ipcRenderer.invoke("trustless:export-proof", recordId);
  }

  async importProof(proofJson: string): Promise<InferenceRecord> {
    return this.ipcRenderer.invoke("trustless:import-proof", proofJson);
  }

  async pinRecord(recordId: string): Promise<void> {
    return this.ipcRenderer.invoke("trustless:pin-record", recordId);
  }

  async unpinRecord(recordId: string): Promise<void> {
    return this.ipcRenderer.invoke("trustless:unpin-record", recordId);
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  async createBatchProof(recordIds: string[]): Promise<string> {
    return this.ipcRenderer.invoke("trustless:create-batch-proof", recordIds);
  }

  async verifyBatchProof(batchProofJson: string): Promise<{
    valid: boolean;
    verifiedCount: number;
    failedIds: string[];
  }> {
    return this.ipcRenderer.invoke("trustless:verify-batch-proof", batchProofJson);
  }

  // ============================================================================
  // Helia Node Status
  // ============================================================================

  async getHeliaStatus(): Promise<HeliaNodeStatus> {
    return this.ipcRenderer.invoke("trustless:helia-status");
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  async getStats(): Promise<InferenceStats> {
    return this.ipcRenderer.invoke("trustless:get-stats");
  }

  // ============================================================================
  // Conversation Operations
  // ============================================================================

  async createConversation(params: {
    provider: LocalModelProvider;
    modelId: string;
    systemPrompt?: string;
    title?: string;
  }): Promise<InferenceConversation> {
    return this.ipcRenderer.invoke("trustless:create-conversation", params);
  }

  async getConversation(conversationId: string): Promise<InferenceConversation | null> {
    return this.ipcRenderer.invoke("trustless:get-conversation", conversationId);
  }

  async listConversations(): Promise<InferenceConversation[]> {
    return this.ipcRenderer.invoke("trustless:list-conversations");
  }

  async deleteConversation(conversationId: string): Promise<void> {
    return this.ipcRenderer.invoke("trustless:delete-conversation", conversationId);
  }

  async updateConversation(
    conversationId: string,
    updates: { title?: string; systemPrompt?: string; provider?: LocalModelProvider; modelId?: string }
  ): Promise<InferenceConversation> {
    return this.ipcRenderer.invoke("trustless:update-conversation", { conversationId, updates });
  }

  async sendMessage(params: {
    conversationId: string;
    message: string;
    config?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      topK?: number;
      repeatPenalty?: number;
      numCtx?: number;
      seed?: number;
      stop?: string[];
    };
    skipVerification?: boolean;
  }): Promise<InferenceResult> {
    return this.ipcRenderer.invoke("trustless:send-message", params);
  }

  // ============================================================================
  // Marketplace Monetization
  // ============================================================================

  /**
   * Mark a saved playground message (prompt or assistant response) for sale on
   * JoyMarketplace. Persists the listing metadata; the renderer is then
   * expected to drive the on-chain mint/list via `CreateAssetWizard`.
   */
  async monetizeMessage(params: {
    messageId?: string;
    conversationId?: string;
    ordinal?: number;
    title: string;
    description?: string;
    priceWei?: string;
    marketplaceAssetId?: string;
  }): Promise<MonetizedPlaygroundMessage> {
    return this.ipcRenderer.invoke("trustless:monetize-message", params);
  }

  async listMonetizedMessages(): Promise<MonetizedPlaygroundMessage[]> {
    return this.ipcRenderer.invoke("trustless:list-monetized-messages");
  }
}

/** Renderer-facing shape of a row from `playground_messages`. */
export interface MonetizedPlaygroundMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  recordId: string | null;
  cid: string | null;
  marketplaceAssetId: string | null;
  priceWei: string | null;
  monetizeTitle: string | null;
  monetizeDescription: string | null;
  monetizedAt: Date | null;
  ordinal: number;
  createdAt: Date;
}

// Export singleton instance
export const trustlessInferenceClient = TrustlessInferenceClient.getInstance();
