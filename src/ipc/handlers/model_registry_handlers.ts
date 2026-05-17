/**
 * Model Registry IPC Handlers
 * Register, search, publish, rate, and manage decentralized model registry.
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import {
  registerModel,
  registerAdapterFromFlywheel,
  getModelEntry,
  searchModels,
  listLocalModels,
  publishModel,
  rateModel,
  recordMABSignal,
  recordModelUsage,
  updateModelEntry,
  deleteModelEntry,
  delistModel,
  getRegistryStats,
  getModelRatings,
  listPeers,
  startModelDownload,
  getDownloadStatus,
  listDownloads,
  type RegisterModelParams,
  type SearchParams,
  type RateModelParams,
} from "@/lib/model_registry_service";
import {
  createModelManifest,
  downloadFromManifest,
  verifyManifest,
  attachManifestSignature,
  manifestSigningDigest,
  compareSemver,
  parseSemver,
  type ModelChunkManifest,
} from "@/lib/model_p2p_distribution";

const logger = log.scope("model_registry_handlers");
const handle = createLoggedHandler(logger);

export function registerModelRegistryHandlers() {
  // Register a new model in the local registry
  handle(
    "model-registry:register",
    async (_event, params: RegisterModelParams) => {
      if (!params.name || !params.version || !params.family || !params.author) {
        throw new Error("Missing required fields: name, version, family, author");
      }
      return registerModel(params);
    },
  );

  // Register an adapter from the data flywheel
  handle(
    "model-registry:register-adapter",
    async (
      _event,
      params: {
        adapterId: string;
        name: string;
        baseModel: string;
        adapterType: "lora" | "qlora" | "full";
        adapterPath: string;
        rank?: number;
        alpha?: number;
        flywheelRunId?: number;
        datasetName?: string;
        trainingPairs?: number;
        epochs?: number;
        agentId?: number;
      },
    ) => {
      if (!params.adapterId || !params.name || !params.baseModel || !params.adapterPath) {
        throw new Error("Missing required fields: adapterId, name, baseModel, adapterPath");
      }
      return registerAdapterFromFlywheel(params);
    },
  );

  // Get a single model entry
  handle(
    "model-registry:get",
    async (_event, args: { id: string }) => {
      if (!args.id) throw new Error("Missing required field: id");
      return getModelEntry(args.id);
    },
  );

  // Search models with filters
  handle(
    "model-registry:search",
    async (_event, params?: SearchParams) => {
      return searchModels(params);
    },
  );

  // List all local models
  handle(
    "model-registry:list-local",
    async () => {
      return listLocalModels();
    },
  );

  // Publish a model to the decentralized network
  handle(
    "model-registry:publish",
    async (_event, args: { modelId: string }) => {
      if (!args.modelId) throw new Error("Missing required field: modelId");
      return publishModel(args.modelId);
    },
  );

  // Rate a model
  handle(
    "model-registry:rate",
    async (_event, params: RateModelParams) => {
      if (!params.modelEntryId || params.score == null) {
        throw new Error("Missing required fields: modelEntryId, score");
      }
      return rateModel(params);
    },
  );

  // Record MAB quality signal
  handle(
    "model-registry:mab-signal",
    async (
      _event,
      args: {
        modelEntryId: string;
        mabAlpha: number;
        mabBeta: number;
        sampleCount: number;
      },
    ) => {
      if (!args.modelEntryId) throw new Error("Missing required field: modelEntryId");
      return recordMABSignal(
        args.modelEntryId,
        args.mabAlpha,
        args.mabBeta,
        args.sampleCount,
      );
    },
  );

  // Record model usage
  handle(
    "model-registry:record-usage",
    async (_event, args: { modelId: string }) => {
      if (!args.modelId) throw new Error("Missing required field: modelId");
      return recordModelUsage(args.modelId);
    },
  );

  // Update a model entry
  handle(
    "model-registry:update",
    async (
      _event,
      args: {
        id: string;
        updates: Partial<{
          name: string;
          description: string;
          tags: string[];
          license: string;
          licenseUrl: string;
        }>;
      },
    ) => {
      if (!args.id) throw new Error("Missing required field: id");
      return updateModelEntry(args.id, args.updates);
    },
  );

  // Delete a model entry (only unpublished local models)
  handle(
    "model-registry:delete",
    async (_event, args: { id: string }) => {
      if (!args.id) throw new Error("Missing required field: id");
      return deleteModelEntry(args.id);
    },
  );

  // Delist a published model
  handle(
    "model-registry:delist",
    async (_event, args: { id: string }) => {
      if (!args.id) throw new Error("Missing required field: id");
      return delistModel(args.id);
    },
  );

  // Get registry stats
  handle("model-registry:stats", async () => {
    return getRegistryStats();
  });

  // Get ratings for a model
  handle(
    "model-registry:get-ratings",
    async (_event, args: { modelEntryId: string }) => {
      if (!args.modelEntryId) throw new Error("Missing required field: modelEntryId");
      return getModelRatings(args.modelEntryId);
    },
  );

  // List known peers
  handle("model-registry:list-peers", async () => {
    return listPeers();
  });

  // Start downloading a model
  handle(
    "model-registry:download",
    async (_event, args: { modelEntryId: string }) => {
      if (!args.modelEntryId) throw new Error("Missing required field: modelEntryId");
      return startModelDownload(args.modelEntryId);
    },
  );

  // Get download status
  handle(
    "model-registry:download-status",
    async (_event, args: { downloadId: string }) => {
      if (!args.downloadId) throw new Error("Missing required field: downloadId");
      return getDownloadStatus(args.downloadId);
    },
  );

  // List active downloads
  handle("model-registry:list-downloads", async () => {
    return listDownloads();
  });

  // ---------------------------------------------------------------------------
  // Phase 5 — P2P chunked distribution
  // ---------------------------------------------------------------------------

  // Build a chunked + hashed manifest for a local model file.
  handle(
    "model-p2p:create-manifest",
    async (
      _event,
      args: {
        filePath: string;
        modelId: string;
        version: string;
        chunkSize?: number;
      },
    ) => {
      if (!args.filePath) throw new Error("Missing required field: filePath");
      if (!args.modelId) throw new Error("Missing required field: modelId");
      if (!args.version) throw new Error("Missing required field: version");
      parseSemver(args.version); // validate
      return createModelManifest({
        filePath: args.filePath,
        modelId: args.modelId,
        version: args.version,
        chunkSize: args.chunkSize,
      });
    },
  );

  // Compute the canonical signing digest for a manifest so the renderer can
  // sign it with the user's wallet.
  handle(
    "model-p2p:signing-digest",
    async (_event, args: { manifest: ModelChunkManifest }) => {
      if (!args.manifest) throw new Error("Missing required field: manifest");
      const { signature: _ignored, ...unsigned } = args.manifest;
      return manifestSigningDigest(unsigned);
    },
  );

  // Attach a publisher signature produced by the renderer wallet.
  handle(
    "model-p2p:attach-signature",
    async (
      _event,
      args: {
        manifest: ModelChunkManifest;
        address: string;
        signature: string;
      },
    ) => {
      if (!args.manifest) throw new Error("Missing required field: manifest");
      if (!args.address) throw new Error("Missing required field: address");
      if (!args.signature) throw new Error("Missing required field: signature");
      const { signature: _ignored, ...unsigned } = args.manifest;
      return attachManifestSignature(unsigned, args.address, args.signature);
    },
  );

  // Verify a manifest's integrity and (optionally) its publisher signature.
  handle(
    "model-p2p:verify-manifest",
    async (
      _event,
      args: {
        manifest: ModelChunkManifest;
        requirePublisherAddress?: string;
      },
    ) => {
      if (!args.manifest) throw new Error("Missing required field: manifest");
      return verifyManifest(args.manifest, {
        requirePublisherAddress: args.requirePublisherAddress,
      });
    },
  );

  // Fetch + reassemble + verify a model from its manifest.
  handle(
    "model-p2p:download",
    async (
      _event,
      args: {
        manifest: ModelChunkManifest;
        outputPath: string;
        maxRetriesPerChunk?: number;
        requirePublisherAddress?: string;
      },
    ) => {
      if (!args.manifest) throw new Error("Missing required field: manifest");
      if (!args.outputPath)
        throw new Error("Missing required field: outputPath");
      return downloadFromManifest(args.manifest, {
        outputPath: args.outputPath,
        maxRetriesPerChunk: args.maxRetriesPerChunk,
        requirePublisherAddress: args.requirePublisherAddress,
      });
    },
  );

  // Semver comparison helper exposed to the renderer (used by version pickers).
  handle(
    "model-p2p:compare-semver",
    async (_event, args: { a: string; b: string }) => {
      return compareSemver(args.a, args.b);
    },
  );
}
