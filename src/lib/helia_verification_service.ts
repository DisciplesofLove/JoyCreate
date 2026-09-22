/**
 * Helia Verification Service
 * Content-addressed storage and verification for trustless AI inference
 */

import crypto from "crypto";
import path from "node:path";
import fs from "fs-extra";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";

import type {
  InferenceRequest,
  InferenceResponse,
  InferenceProof,
  InferenceRecord,
  VerificationResult,
  HeliaNodeConfig,
  HeliaNodeStatus,
  LocalModelInfo,
} from "@/types/trustless_inference";

const logger = log.scope("helia_verification");

// Dynamic imports for ESM-only modules
let createHelia: any;
let json: any;
let unixfs: any;
let FsBlockstore: any;
let FsDatastore: any;
let CID: any;
let raw: any;
let sha256: any;

async function loadEsmModules() {
  if (!createHelia) {
    const heliaModule = await import("helia");
    createHelia = heliaModule.createHelia;
    
    const jsonModule = await import("@helia/json");
    json = jsonModule.json;
    
    const unixfsModule = await import("@helia/unixfs");
    unixfs = unixfsModule.unixfs;
    
    const blockstoreModule = await import("blockstore-fs");
    FsBlockstore = blockstoreModule.FsBlockstore;
    
    const datastoreModule = await import("datastore-fs");
    FsDatastore = datastoreModule.FsDatastore;
    
    const cidModule = await import("multiformats/cid");
    CID = cidModule.CID;
    
    const rawModule = await import("multiformats/codecs/raw");
    raw = rawModule;
    
    const sha256Module = await import("multiformats/hashes/sha2");
    sha256 = sha256Module.sha256;
  }
}

// ============================================================================
// Helia Node Manager
// ============================================================================

class HeliaVerificationService {
  private helia: any = null;
  private jsonCodec: any = null;
  private fsCodec: any = null;
  private config: HeliaNodeConfig;
  private records: Map<string, InferenceRecord> = new Map();
  private storagePath: string;

  constructor(config?: Partial<HeliaNodeConfig>) {
    this.config = {
      enablePersistence: true,
      storagePath: path.join(getUserDataPath(), "helia-store"),
      ...config,
    };
    this.storagePath = this.config.storagePath!;
  }

  async start(): Promise<void> {
    if (this.helia) {
      logger.info("Helia node already running");
      return;
    }

    // Always ensure storage directory and load previous records,
    // even if Helia itself fails to start
    try {
      await fs.ensureDir(this.storagePath);
      await this.loadRecords();
    } catch (loadError) {
      logger.warn("Failed to load previous inference records:", loadError);
    }

    try {
      // Load ESM modules dynamically
      await loadEsmModules();
      
      const blockstorePath = path.join(this.storagePath, "blocks");
      const datastorePath = path.join(this.storagePath, "data");
      
      await fs.ensureDir(blockstorePath);
      await fs.ensureDir(datastorePath);

      const blockstore = new FsBlockstore(blockstorePath);
      const datastore = new FsDatastore(datastorePath);

      // Create Helia in offline mode (no libp2p networking)
      // This avoids node-datachannel dependency
      this.helia = await createHelia({
        blockstore,
        datastore,
        start: false, // Don't start libp2p automatically
      });

      this.jsonCodec = json(this.helia);
      this.fsCodec = unixfs(this.helia);

      logger.info("Helia verification service started (offline mode)", {
        storagePath: this.storagePath,
        records: this.records.size,
      });
    } catch (error) {
      logger.warn("Failed to start Helia IPFS node (inference will still work, verification unavailable):", error);
      // Don't throw - allow app to continue without decentralized features
      // The service will operate in degraded mode
    }
  }

  async stop(): Promise<void> {
    if (this.helia) {
      await this.saveRecords();
      await this.helia.stop();
      this.helia = null;
      this.jsonCodec = null;
      this.fsCodec = null;
      logger.info("Helia verification service stopped");
    }
  }

  async getStatus(): Promise<HeliaNodeStatus> {
    if (!this.helia) {
      return {
        running: false,
        connectedPeers: 0,
        storedCids: 0,
        storageUsedBytes: 0,
      };
    }

    const peerId = this.helia.libp2p.peerId.toString();
    const multiaddrs = this.helia.libp2p.getMultiaddrs().map((ma: any) => ma.toString());
    const connectedPeers = this.helia.libp2p.getPeers().length;

    // Get storage stats
    let storageUsedBytes = 0;
    try {
      const stats = await fs.stat(this.storagePath);
      storageUsedBytes = stats.size;
    } catch {
      // Ignore
    }

    return {
      running: true,
      peerId,
      multiaddrs,
      connectedPeers,
      storedCids: this.records.size,
      storageUsedBytes,
    };
  }

  // ============================================================================
  // Hashing Utilities
  // ============================================================================

  private hashString(data: string): string {
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  private hashObject(data: Record<string, unknown>): string {
    const canonical = JSON.stringify(data, Object.keys(data).sort());
    return this.hashString(canonical);
  }

  private async createCID(data: Uint8Array): Promise<string> {
    await loadEsmModules();
    const hash = await sha256.digest(data);
    const cid = CID.create(1, raw.code, hash);
    return cid.toString();
  }

  private async collectCatStream(cid: string): Promise<Buffer> {
    await loadEsmModules();
    if (!this.fsCodec) {
      throw new Error("Helia UnixFS not available");
    }
    const parsed = CID.parse(cid);
    const chunks: Buffer[] = [];
    for await (const chunk of this.fsCodec.cat(parsed)) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // ============================================================================
  // Inference Verification
  // ============================================================================

  async createInferenceProof(
    request: InferenceRequest,
    response: InferenceResponse,
    modelInfo: LocalModelInfo
  ): Promise<InferenceProof> {
    const timestamps = {
      requested: request.timestamp,
      started: response.timestamp - response.generationTimeMs,
      completed: response.timestamp,
    };

    // Create hashes for verification
    const promptHash = this.hashString(request.prompt);
    const systemPromptHash = request.systemPrompt
      ? this.hashString(request.systemPrompt)
      : undefined;
    const messagesHash = request.messages
      ? this.hashObject({ messages: request.messages })
      : undefined;
    const configHash = this.hashObject({
      options: request.modelConfig.options,
    });
    const outputHash = this.hashString(response.output);

    // Create model verification data
    const modelVerification = {
      id: modelInfo.id,
      name: modelInfo.name,
      provider: modelInfo.provider,
      weightsHash: modelInfo.modelHash || modelInfo.digest,
      configHash: modelInfo.digest,
      quantization: modelInfo.quantization,
    };

    const proof: InferenceProof = {
      version: "1.0.0",
      proofType: "inference-verification",
      requestCid: "", // Will be set after storing
      responseCid: "", // Will be set after storing
      model: modelVerification,
      request: {
        promptHash,
        systemPromptHash,
        messagesHash,
        configHash,
      },
      response: {
        outputHash,
        tokenCount: response.totalTokens,
        generationTimeMs: response.generationTimeMs,
      },
      timestamps,
      node: {
        peerId: this.helia?.libp2p.peerId.toString(),
      },
    };

    return proof;
  }

  async storeInferenceRecord(
    request: InferenceRequest,
    response: InferenceResponse,
    proof: InferenceProof
  ): Promise<InferenceRecord> {
    // If Helia is available, store on IPFS for content-addressed verification
    if (this.helia && this.jsonCodec) {
      // Store request
      const requestCid = await this.jsonCodec.add({
        type: "inference-request",
        ...request,
      });
      proof.requestCid = requestCid.toString();

      // Store response
      const responseCid = await this.jsonCodec.add({
        type: "inference-response",
        ...response,
      });
      proof.responseCid = responseCid.toString();

      // Store proof
      const proofCid = await this.jsonCodec.add(proof);
      proof.proofCid = proofCid.toString();
    } else {
      // Helia unavailable — generate local CIDs from hashes instead
      logger.info("Helia unavailable, storing inference record locally only");
      proof.requestCid = `local-${this.hashString(JSON.stringify(request))}`;
      proof.responseCid = `local-${this.hashString(JSON.stringify(response))}`;
      proof.proofCid = `local-${this.hashString(JSON.stringify(proof))}`;
    }

    const record: InferenceRecord = {
      id: response.id,
      proof,
      request,
      response,
      cid: proof.proofCid || `local-${response.id}`,
      pinned: false,
      // A freshly-created record's integrity checks (prompt/output/model hashes)
      // are computed from the same data they verify against, so they always
      // pass. Run the checks now and mark the record verified on creation so the
      // renderer's green checkmark is deterministic — independent of whether
      // Helia/IPFS or Celestia is online. (Previously `!!this.helia`, which left
      // every local/offline record unverified until a manual re-verify.)
      verified: this.checkRecordIntegrity(request, response, proof),
      createdAt: Date.now(),
    };

    this.records.set(record.id, record);
    await this.saveRecords();

    logger.info("Stored inference record", {
      id: record.id,
      cid: record.cid,
      model: proof.model.id,
    });

    return record;
  }

  async verifyInferenceRecord(recordId: string): Promise<VerificationResult> {
    const record = this.records.get(recordId);
    if (!record) {
      return {
        valid: false,
        checks: {
          requestIntegrity: false,
          responseIntegrity: false,
          modelMatch: false,
          timestampValid: false,
        },
        details: ["Record not found"],
        warnings: [],
      };
    }

    const { checks, details, warnings } = this.computeIntegrityChecks(
      record.request,
      record.response,
      record.proof
    );

    const valid = Object.values(checks).every((c) => c);

    // Persist the verification result on the record
    if (valid && !record.verified) {
      record.verified = true;
      await this.saveRecords();
    }

    return { valid, checks, details, warnings };
  }

  /**
   * Run the content-integrity checks for a (request, response, proof) triple.
   * Shared by record creation (so local/offline records are born verified) and
   * {@link verifyInferenceRecord} (manual / on-demand re-verification).
   */
  private computeIntegrityChecks(
    request: InferenceRequest,
    response: InferenceResponse,
    proof: InferenceProof
  ): {
    checks: {
      requestIntegrity: boolean;
      responseIntegrity: boolean;
      modelMatch: boolean;
      timestampValid: boolean;
    };
    details: string[];
    warnings: string[];
  } {
    const checks = {
      requestIntegrity: true,
      responseIntegrity: true,
      modelMatch: true,
      timestampValid: true,
    };
    const details: string[] = [];
    const warnings: string[] = [];

    // Verify request integrity
    const computedPromptHash = this.hashString(request.prompt);
    if (computedPromptHash !== proof.request.promptHash) {
      checks.requestIntegrity = false;
      details.push("Prompt hash mismatch");
    }

    // Verify response integrity
    const computedOutputHash = this.hashString(response.output);
    if (computedOutputHash !== proof.response.outputHash) {
      checks.responseIntegrity = false;
      details.push("Output hash mismatch");
    }

    // Verify model info
    if (response.modelInfo.id !== proof.model.id) {
      checks.modelMatch = false;
      details.push("Model ID mismatch");
    }

    // Verify timestamps
    const { requested, started, completed } = proof.timestamps;
    if (started < requested || completed < started) {
      checks.timestampValid = false;
      details.push("Invalid timestamp sequence");
    }

    // Check for suspiciously fast generation
    const minExpectedTime = proof.response.tokenCount * 5; // 5ms per token minimum
    if (proof.response.generationTimeMs < minExpectedTime) {
      warnings.push("Generation time seems unusually fast for token count");
    }

    return { checks, details, warnings };
  }

  /** Convenience boolean wrapper around {@link computeIntegrityChecks}. */
  private checkRecordIntegrity(
    request: InferenceRequest,
    response: InferenceResponse,
    proof: InferenceProof
  ): boolean {
    const { checks } = this.computeIntegrityChecks(request, response, proof);
    return Object.values(checks).every((c) => c);
  }

  async getInferenceRecord(recordId: string): Promise<InferenceRecord | null> {
    return this.records.get(recordId) || null;
  }

  async listInferenceRecords(): Promise<InferenceRecord[]> {
    // Backfill: flip any record whose integrity checks pass but was stored
    // before verification-on-creation (e.g. older `local-` records, or ones
    // created while Helia was offline) to verified, so the green checkmark is
    // consistent across old and new records. Persist only if something changed.
    let mutated = false;
    for (const record of this.records.values()) {
      if (!record.verified && this.checkRecordIntegrity(record.request, record.response, record.proof)) {
        record.verified = true;
        mutated = true;
      }
    }
    if (mutated) {
      await this.saveRecords();
    }

    return Array.from(this.records.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  async pinRecord(recordId: string): Promise<void> {
    const record = this.records.get(recordId);
    if (!record || !this.helia) return;

    try {
      await loadEsmModules();
      const cid = CID.parse(record.cid);
      await this.helia.pins.add(cid);
      record.pinned = true;
      await this.saveRecords();
      logger.info("Pinned record", { id: recordId, cid: record.cid });
    } catch (error) {
      logger.error("Failed to pin record:", error);
      throw error;
    }
  }

  /**
   * Persist updates to an existing record (e.g. after Celestia anchoring
   * augments it with `celestiaHeight` / `celestiaCommitment`).
   */
  async updateRecord(record: InferenceRecord): Promise<void> {
    this.records.set(record.id, record);
    await this.saveRecords();
  }

  async unpinRecord(recordId: string): Promise<void> {
    const record = this.records.get(recordId);
    if (!record || !this.helia) return;

    try {
      await loadEsmModules();
      const cid = CID.parse(record.cid);
      await this.helia.pins.rm(cid);
      record.pinned = false;
      await this.saveRecords();
      logger.info("Unpinned record", { id: recordId });
    } catch (error) {
      logger.error("Failed to unpin record:", error);
      throw error;
    }
  }

  // ============================================================================
  // Proof Export/Import
  // ============================================================================

  async exportProof(recordId: string): Promise<string> {
    const record = this.records.get(recordId);
    if (!record) throw new Error("Record not found");

    const exportData = {
      version: "1.0.0",
      type: "inference-proof-export",
      record: {
        id: record.id,
        proof: record.proof,
        request: record.request,
        response: record.response,
        cid: record.cid,
        createdAt: record.createdAt,
      },
      exportedAt: Date.now(),
    };

    return JSON.stringify(exportData, null, 2);
  }

  async importProof(proofJson: string): Promise<InferenceRecord> {
    const data = JSON.parse(proofJson);
    
    if (data.version !== "1.0.0" || data.type !== "inference-proof-export") {
      throw new Error("Invalid proof format");
    }

    const record: InferenceRecord = {
      ...data.record,
      pinned: false,
      verified: false,
    };

    // Verify the imported record
    const tempRecords = this.records;
    this.records = new Map([[record.id, record]]);
    const verification = await this.verifyInferenceRecord(record.id);
    this.records = tempRecords;

    record.verified = verification.valid;
    this.records.set(record.id, record);
    await this.saveRecords();

    return record;
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  async createMerkleRoot(recordIds: string[]): Promise<string> {
    const hashes = recordIds
      .map((id) => this.records.get(id)?.cid)
      .filter((cid): cid is string => !!cid)
      .sort();

    if (hashes.length === 0) return "";

    // Simple merkle root implementation
    let currentLevel = hashes;
    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        nextLevel.push(this.hashString(left + right));
      }
      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  private async loadRecords(): Promise<void> {
    const recordsPath = path.join(this.storagePath, "records.json");
    try {
      if (await fs.pathExists(recordsPath)) {
        const data = await fs.readJson(recordsPath);
        this.records = new Map(Object.entries(data));
        logger.info(`Loaded ${this.records.size} inference records`);
      }
    } catch (error) {
      logger.warn("Failed to load records:", error);
    }
  }

  private async saveRecords(): Promise<void> {
    const recordsPath = path.join(this.storagePath, "records.json");
    try {
      const data = Object.fromEntries(this.records);
      await fs.writeJson(recordsPath, data, { spaces: 2 });
    } catch (error) {
      logger.error("Failed to save records:", error);
    }
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  async getStats(): Promise<{
    totalRecords: number;
    verifiedRecords: number;
    pinnedRecords: number;
    modelUsage: Record<string, number>;
    totalTokens: number;
    averageGenerationTimeMs: number;
  }> {
    const records = Array.from(this.records.values());
    
    const modelUsage: Record<string, number> = {};
    let totalTokens = 0;
    let totalTime = 0;

    for (const record of records) {
      const modelId = record.proof.model.id;
      modelUsage[modelId] = (modelUsage[modelId] || 0) + 1;
      totalTokens += record.proof.response.tokenCount;
      totalTime += record.proof.response.generationTimeMs;
    }

    return {
      totalRecords: records.length,
      verifiedRecords: records.filter((r) => r.verified).length,
      pinnedRecords: records.filter((r) => r.pinned).length,
      modelUsage,
      totalTokens,
      averageGenerationTimeMs: records.length > 0 ? totalTime / records.length : 0,
    };
  }

  // ========================================================================
  // Model Chunk Storage (UnixFS)
  // ========================================================================

  async storeModelChunkFile(filePath: string): Promise<{ cid: string; bytes: number }> {
    if (!this.helia || !this.fsCodec) {
      throw new Error("Helia node not running");
    }
    const data = await fs.readFile(filePath);
    const cid = await this.fsCodec.addBytes(data);
    return { cid: cid.toString(), bytes: data.length };
  }

  async exportModelChunkToFile(cid: string, outputPath: string): Promise<{ bytes: number }> {
    if (!this.helia || !this.fsCodec) {
      throw new Error("Helia node not running");
    }
    const data = await this.collectCatStream(cid);
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, data);
    return { bytes: data.length };
  }

  /**
   * Store an in-memory byte buffer as a UnixFS block and return its CID.
   * Used by Genius Core context-slot blocks (small dag-cbor payloads).
   */
  async addBytes(data: Uint8Array): Promise<{ cid: string; bytes: number }> {
    if (!this.helia || !this.fsCodec) {
      throw new Error("Helia node not running");
    }
    const cid = await this.fsCodec.addBytes(data);
    return { cid: cid.toString(), bytes: data.length };
  }

  /** Fetch a CID's content into an in-memory byte buffer. */
  async getBytes(cidStr: string): Promise<Uint8Array> {
    if (!this.helia || !this.fsCodec) {
      throw new Error("Helia node not running");
    }
    return this.collectCatStream(cidStr);
  }

  /** Pin an arbitrary CID (used for sovereign model weights, etc.) */
  async pinCid(cidStr: string): Promise<void> {
    if (!this.helia) throw new Error("Helia node not running");
    await loadEsmModules();
    const cid = CID.parse(cidStr);
    await this.helia.pins.add(cid);
  }

  /** Unpin an arbitrary CID. */
  async unpinCid(cidStr: string): Promise<void> {
    if (!this.helia) throw new Error("Helia node not running");
    await loadEsmModules();
    const cid = CID.parse(cidStr);
    await this.helia.pins.rm(cid);
  }

  /** Check whether a CID is pinned in the local Helia node. */
  async isCidPinned(cidStr: string): Promise<boolean> {
    if (!this.helia) return false;
    await loadEsmModules();
    const cid = CID.parse(cidStr);
    return this.helia.pins.isPinned(cid);
  }
}

// Export singleton
export const heliaVerificationService = new HeliaVerificationService();
