import { z } from "zod";

export const SecretSchema = z.object({
  value: z.string(),
  encryptionType: z.enum(["electron-safe-storage", "plaintext"]).optional(),
});
export type Secret = z.infer<typeof SecretSchema>;

/**
 * Zod schema for chat summary objects returned by the get-chats IPC
 */
export const ChatSummarySchema = z.object({
  id: z.number(),
  appId: z.number(),
  title: z.string().nullable(),
  createdAt: z.date(),
});

/**
 * Type derived from the ChatSummarySchema
 */
export type ChatSummary = z.infer<typeof ChatSummarySchema>;

/**
 * Zod schema for an array of chat summaries
 */
export const ChatSummariesSchema = z.array(ChatSummarySchema);

/**
 * Zod schema for chat search result objects returned by the search-chats IPC
 */
export const ChatSearchResultSchema = z.object({
  id: z.number(),
  appId: z.number(),
  title: z.string().nullable(),
  createdAt: z.date(),
  matchedMessageContent: z.string().nullable(),
});

/**
 * Type derived from the ChatSearchResultSchema
 */
export type ChatSearchResult = z.infer<typeof ChatSearchResultSchema>;

export const ChatSearchResultsSchema = z.array(ChatSearchResultSchema);

// Zod schema for app search result objects returned by the search-app IPC
export const AppSearchResultSchema = z.object({
  id: z.number(),
  name: z.string(),
  createdAt: z.date(),
  matchedChatTitle: z.string().nullable(),
  matchedChatMessage: z.string().nullable(),
});

// Type derived from AppSearchResultSchema
export type AppSearchResult = z.infer<typeof AppSearchResultSchema>;

export const AppSearchResultsSchema = z.array(AppSearchResultSchema);

const providers = [
  "openai",
  "anthropic",
  "google",
  "vertex",
  "auto",
  "openrouter",
  "ollama",
  "lmstudio",
  "azure",
  "xai",
  "bedrock",
  // Image generation providers
  "stabilityai",
  "replicate",
  "fal",
  "runway",
  // Video generation providers
  "luma",
] as const;

export const cloudProviders = providers.filter(
  (provider) => provider !== "ollama" && provider !== "lmstudio",
);

/**
 * Zod schema for large language model configuration
 */
export const LargeLanguageModelSchema = z.object({
  name: z.string(),
  provider: z.string(),
  customModelId: z.number().optional(),
});

/**
 * Type derived from the LargeLanguageModelSchema
 */
export type LargeLanguageModel = z.infer<typeof LargeLanguageModelSchema>;

/**
 * Zod schema for provider settings
 * Regular providers use only apiKey. Vertex has additional optional fields.
 */
export const RegularProviderSettingSchema = z.object({
  apiKey: SecretSchema.optional(),
});

export const AzureProviderSettingSchema = z.object({
  apiKey: SecretSchema.optional(),
  resourceName: z.string().optional(),
});

export const VertexProviderSettingSchema = z.object({
  // We make this undefined so that it makes existing callsites easier.
  apiKey: z.undefined(),
  projectId: z.string().optional(),
  location: z.string().optional(),
  serviceAccountKey: SecretSchema.optional(),
});

export const ProviderSettingSchema = z.union([
  // Must use more specific type first!
  // Zod uses the first type that matches.
  //
  // We use passthrough as a hack because Azure and Vertex
  // will match together since their required fields overlap.
  //
  // In addition, there may be future provider settings that
  // we may want to preserve (e.g. user downgrades to older version)
  // so doing passthrough keeps these extra fields.
  AzureProviderSettingSchema.passthrough(),
  VertexProviderSettingSchema.passthrough(),
  RegularProviderSettingSchema.passthrough(),
]);

/**
 * Type derived from the ProviderSettingSchema
 */
export type ProviderSetting = z.infer<typeof ProviderSettingSchema>;
export type RegularProviderSetting = z.infer<
  typeof RegularProviderSettingSchema
>;
export type AzureProviderSetting = z.infer<typeof AzureProviderSettingSchema>;
export type VertexProviderSetting = z.infer<typeof VertexProviderSettingSchema>;

export const RuntimeModeSchema = z.enum(["web-sandbox", "local-node", "unset"]);
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

export const RuntimeMode2Schema = z.enum(["host", "docker"]);
export type RuntimeMode2 = z.infer<typeof RuntimeMode2Schema>;

export const ChatModeSchema = z.enum([
  "build",
  "ask",
  "agent",
  "autonomous",
  "mcp",
  "local-agent",
  "plan",
]);
export type ChatMode = z.infer<typeof ChatModeSchema>;

export const ModeTokenBudgetsSchema = z
  .object({
    agent: z.number().int().positive().optional(),
    autonomous: z.number().int().positive().optional(),
    mcp: z.number().int().positive().optional(),
    "local-agent": z.number().int().positive().optional(),
  })
  .partial();
export type ModeTokenBudgets = z.infer<typeof ModeTokenBudgetsSchema>;

export const GitHubSecretsSchema = z.object({
  accessToken: SecretSchema.nullable(),
});
export type GitHubSecrets = z.infer<typeof GitHubSecretsSchema>;

export const GithubUserSchema = z.object({
  email: z.string(),
});
export type GithubUser = z.infer<typeof GithubUserSchema>;

/**
 * Supabase organization credentials.
 * Each organization has its own OAuth tokens.
 */
export const SupabaseOrganizationCredentialsSchema = z.object({
  accessToken: SecretSchema,
  refreshToken: SecretSchema,
  expiresIn: z.number(),
  tokenTimestamp: z.number(),
});
export type SupabaseOrganizationCredentials = z.infer<
  typeof SupabaseOrganizationCredentialsSchema
>;

export const SupabaseSchema = z.object({
  // Map keyed by organizationSlug -> organization credentials
  organizations: z
    .record(z.string(), SupabaseOrganizationCredentialsSchema)
    .optional(),

  // Legacy fields - kept for backwards compat
  accessToken: SecretSchema.optional(),
  refreshToken: SecretSchema.optional(),
  expiresIn: z.number().optional(),
  tokenTimestamp: z.number().optional(),
});
export type Supabase = z.infer<typeof SupabaseSchema>;

export const NeonSchema = z.object({
  accessToken: SecretSchema.optional(),
  refreshToken: SecretSchema.optional(),
  expiresIn: z.number().optional(),
  tokenTimestamp: z.number().optional(),
});
export type Neon = z.infer<typeof NeonSchema>;

export const ExperimentsSchema = z.object({
  enableLocalAgent: z.boolean().optional(),
  // Deprecated
  enableSupabaseIntegration: z.boolean().describe("DEPRECATED").optional(),
  enableFileEditing: z.boolean().describe("DEPRECATED").optional(),
});
export type Experiments = z.infer<typeof ExperimentsSchema>;

/**
 * User customization for which sidebar navigation items are shown.
 *
 * Visibility rules (see `isSidebarItemVisible` in `sidebar-menu.ts`):
 * - Stable items (no `stage`): visible unless their id is in `hiddenItems`.
 * - Beta/dev items: hidden by default. Revealed either by the matching master
 *   switch (`showBeta` / `showDev`) or by adding their id to `enabledItems`.
 *   An explicit entry in `hiddenItems` always wins.
 */
export const SidebarPreferencesSchema = z.object({
  /** Ids of items the user has explicitly hidden (applies to any stage). */
  hiddenItems: z.array(z.string()).optional(),
  /** Ids of individual beta/dev items the user has explicitly turned on. */
  enabledItems: z.array(z.string()).optional(),
  /** Master switch: reveal all `beta` items at once. */
  showBeta: z.boolean().optional(),
  /** Master switch: reveal all `dev` (in-development) items at once. */
  showDev: z.boolean().optional(),
});
export type SidebarPreferences = z.infer<typeof SidebarPreferencesSchema>;

export const JoyBudgetSchema = z.object({
  budgetResetAt: z.string(),
  maxBudget: z.number(),
});
export type JoyBudget = z.infer<typeof JoyBudgetSchema>;

export const GlobPathSchema = z.object({
  globPath: z.string(),
});

export type GlobPath = z.infer<typeof GlobPathSchema>;

export const AppChatContextSchema = z.object({
  contextPaths: z.array(GlobPathSchema),
  smartContextAutoIncludes: z.array(GlobPathSchema),
  excludePaths: z.array(GlobPathSchema).optional(),
});
export type AppChatContext = z.infer<typeof AppChatContextSchema>;

export type ContextPathResult = GlobPath & {
  files: number;
  tokens: number;
};

export type ContextPathResults = {
  contextPaths: ContextPathResult[];
  smartContextAutoIncludes: ContextPathResult[];
  excludePaths: ContextPathResult[];
};

export const ReleaseChannelSchema = z.enum(["stable", "beta"]);
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

export const ZoomLevelSchema = z.enum(["90", "100", "110", "125", "150"]);
export type ZoomLevel = z.infer<typeof ZoomLevelSchema>;

export const SmartContextModeSchema = z.enum([
  "balanced",
  "conservative",
  "deep",
]);
export type SmartContextMode = z.infer<typeof SmartContextModeSchema>;

export const AgentToolConsentSchema = z.enum(["ask", "always"]);
export type AgentToolConsent = z.infer<typeof AgentToolConsentSchema>;

/**
 * Zod schema for user settings
 */
export const UserSettingsSchema = z.object({
  selectedModel: LargeLanguageModelSchema,
  providerSettings: z.record(z.string(), ProviderSettingSchema),
  agentToolConsents: z.record(z.string(), AgentToolConsentSchema).optional(),
  githubUser: GithubUserSchema.optional(),
  githubAccessToken: SecretSchema.optional(),
  huggingFaceToken: SecretSchema.optional(),
  vercelAccessToken: SecretSchema.optional(),
  supabase: SupabaseSchema.optional(),
  neon: NeonSchema.optional(),
  autoApproveChanges: z.boolean().optional(),
  telemetryConsent: z.enum(["opted_in", "opted_out", "unset"]).optional(),
  telemetryUserId: z.string().optional(),
  hasRunBefore: z.boolean().optional(),
  /**
   * Phase 3 onboarding wizard — flipped to true when the user finishes or
   * explicitly skips the multi-step setup at `/onboarding`. Used as a soft
   * gate so existing installs (where this field is undefined) are never
   * forced through the wizard.
   */
  onboardingComplete: z.boolean().optional(),
  /** @deprecated All features are now free. Kept for backward compat with existing settings files. */
  enableJoyPro: z.boolean().optional(),
  experiments: ExperimentsSchema.optional(),
  /** Per-user customization of which sidebar navigation items are shown. */
  sidebar: SidebarPreferencesSchema.optional(),
  lastShownReleaseNotesVersion: z.string().optional(),
  maxChatTurnsInContext: z.number().optional(),
  thinkingBudget: z.enum(["low", "medium", "high"]).optional(),
  /** Copilot-style reasoning effort preset. Overrides `thinkingBudget` when set. */
  reasoningEffort: z.enum(["low", "medium", "high", "ultra"]).optional(),
  /** Advanced: explicit sampling temperature (0-2). null/undefined = use the model default. */
  temperatureOverride: z.number().min(0).max(2).nullable().optional(),
  enableProLazyEditsMode: z.boolean().optional(),
  proLazyEditsMode: z.enum(["off", "v1", "v2"]).optional(),
  enableProSmartFilesContextMode: z.boolean().optional(),
  enableProWebSearch: z.boolean().optional(),
  proSmartContextOption: SmartContextModeSchema.optional(),
  selectedTemplateId: z.string(),
  enableSupabaseWriteSqlMigration: z.boolean().optional(),
  selectedChatMode: ChatModeSchema.optional(),
  /** Per-mode `stepCountIs` cap for agentic loops (agent/autonomous/mcp/local-agent). */
  modeTokenBudgets: ModeTokenBudgetsSchema.optional(),
  /** When true, autonomous mode halts on the first failed phase instead of continuing. */
  autonomousStopOnError: z.boolean().optional(),
  /** Model used for Document Studio AI generation and in-editor AI commands. Falls back to selectedModel when undefined. */
  documentAiModel: LargeLanguageModelSchema.optional(),
  acceptedCommunityCode: z.boolean().optional(),
  zoomLevel: ZoomLevelSchema.optional(),

  enableAutoFixProblems: z.boolean().optional(),
  enableNativeGit: z.boolean().optional(),
  enableAutoUpdate: z.boolean(),
  releaseChannel: ReleaseChannelSchema,
  runtimeMode2: RuntimeMode2Schema.optional(),
  customNodePath: z.string().optional().nullable(),
  isRunning: z.boolean().optional(),
  /** Auto-start the Hypercore peer layer (Holepunch) on app boot. Default true. */
  hyperEnabled: z.boolean().optional(),
  lastKnownPerformance: z
    .object({
      timestamp: z.number(),
      memoryUsageMB: z.number(),
      cpuUsagePercent: z.number().optional(),
      systemMemoryUsageMB: z.number().optional(),
      systemMemoryTotalMB: z.number().optional(),
      systemCpuPercent: z.number().optional(),
    })
    .optional(),

  ////////////////////////////////
  // JOY BLOCKCHAIN IDENTITY
  ////////////////////////////////
  joyId: z.string().optional(),
  collectionContract: z.string().optional(),

  ////////////////////////////////
  // TAILSCALE VPN
  ////////////////////////////////
  tailscale: z
    .object({
      enabled: z.boolean(),
      exposeServices: z.boolean(),
      manualIp: z.string().optional(),
      exposedServices: z.object({
        ollama: z.boolean(),
        n8n: z.boolean(),
        celestia: z.boolean(),
        openclaw: z.boolean(),
      }),
    })
    .optional(),

  ////////////////////////////////
  // MCP SERVER
  ////////////////////////////////
  mcpServer: z
    .object({
      enabled: z.boolean(),
      port: z.number(),
    })
    .optional(),

  ////////////////////////////////
  // VOICE / TTS
  ////////////////////////////////
  elevenlabsApiKey: z.string().optional(),
  elevenlabsVoiceId: z.string().optional(),
  // Persisted MCP tool allow-list for the Voice Assistant. Stored as the
  // fully-qualified tool names (`mcp__<server>__<tool>`) the user has
  // explicitly granted voice access to. `undefined` = unrestricted (all
  // enabled servers' tools); `[]` = no MCP tools.
  voiceMcpToolsAllow: z.array(z.string()).optional(),

  ////////////////////////////////
  // TELEGRAM BOT OWNERSHIP
  ////////////////////////////////
  /**
   * Which process owns the Telegram bot's getUpdates polling.
   * - `"local"` (default): JoyCreate's in-process bot owns polling so it can
   *   call IPC handlers and execute tools. The OpenClaw daemon's Telegram
   *   channel is suppressed to avoid 409 conflicts.
   * - `"daemon"`: the OpenClaw daemon owns Telegram (legacy behavior).
   */
  telegramOwner: z.enum(["local", "daemon"]).optional(),
  /**
   * JoyCreate's OWN independent Telegram bot token for the in-process agentic
   * bot ("the agent"). When set, the local bot polls this token directly,
   * decoupled from the OpenClaw daemon's `channels.telegram.botToken` ("the
   * bot"). This lets the agent run on a dedicated bot while the daemon can
   * optionally run a separate plain bot on its own token. Stored here (not in
   * openclaw.json) so it survives the daemon's periodic config rewrites.
   */
  telegramBotToken: z.string().optional(),

  ////////////////////////////////
  // E2E TESTING ONLY.
  ////////////////////////////////
  isTestMode: z.boolean().optional(),

  /**
   * DEAI Phase 1A — feature flag. When true, `workflow:publish-to-marketplace`
   * also publishes the workflow on-chain as an ERC-1155 via the
   * PublishOrchestrator IN ADDITION to the legacy Supabase publish (dual-write).
   * Default OFF so existing marketplace items are never lost.
   */
  marketplaceWorkflowOnChain: z.boolean().optional(),

  /**
   * Marketplace network selection. Default `polygonAmoy` matches the existing
   * production behavior — Arbitrum routes are opt-in, additive, and ignore
   * `JoyCreatorGate` (.joy ENS) gating. Switching does not migrate or hide
   * any previously published items.
   */
  marketplaceChain: z
    .enum(["polygonAmoy", "arbitrumSepolia", "arbitrumOne"])
    .optional(),

  /**
   * Creator store slug ("our store") that published assets are licensed to.
   * Used as the StoreRegistry slug for the EditionController drop on Arbitrum;
   * auto-registered on first publish if it does not yet exist. When unset,
   * assets still mint but no purchasable x402 drop is created.
   */
  marketplaceStoreSlug: z.string().optional(),

  ////////////////////////////////
  // GENIUS CORE (local ONNX runtime)
  ////////////////////////////////
  /**
   * Local edge-native neural runtime that sits beside Ollama/LMStudio as a
   * third local provider. All fields optional so existing installs keep
   * working unchanged. See `src/lib/genius_core/`.
   */
  geniusCore: z
    .object({
      enabled: z.boolean(),
      /** Maximum VRAM the engine may allocate, in gigabytes. */
      vramBudgetGb: z.number().min(1).max(96),
      /** Model registry id of the base layer model. */
      baseModelId: z.string(),
      /** ONNX Runtime execution provider preference. */
      executionProvider: z.enum([
        "auto",
        "webgpu",
        "directml",
        "coreml",
        "cuda",
        "cpu",
      ]),
      /** Absolute path under userData for per-project IPLD context slot cache. */
      contextSlotsDir: z.string().optional(),
      /**
       * Max number of historical context slots to keep per project after a
       * successful adapter promotion. The current head + most-recent N
       * slots are kept; older slots are unpinned (best-effort). Slots
       * with `metadata.published === true` are always preserved.
       * Default: 10. Set to 0 to disable auto-prune.
       */
      slotHistoryKeepLast: z.number().int().min(0).optional(),
      /** Route lightweight background work (telemetry, indexing) to NPU when available. */
      npuOffloadEnabled: z.boolean(),
      /** Allow live P2P weight-shard streaming for off-local-cache inference steps. */
      weightStreamingEnabled: z.boolean(),
      /**
       * Order-respecting edit logger for online structural learning.
       * SEPARATE from `telemetryConsent` — must be explicitly opted in.
       * When true, also requires `telemetryConsent === "opted_in"` to actually capture.
       */
      keystrokeLoggerEnabled: z.boolean(),
      /**
       * Per-project privacy overrides for the keystroke/edit logger.
       * Map of `projectId.toString()` → boolean. When a project has an
       * explicit entry it WINS (both true and false) over the global
       * `keystrokeLoggerEnabled` flag. Projects without an entry fall
       * through to the global flag. Always still gated by
       * `telemetryConsent === "opted_in"`.
       */
      keystrokeLoggerProjectOverrides: z
        .record(z.string(), z.boolean())
        .optional(),
      /** Nightly idle-triggered QLoRA distillation. Off by default. */
      nightlyDistillationEnabled: z.boolean(),
      /**
       * Mirror Genius Core metadata events (slot CIDs, edit-log batch hashes,
       * distillation receipts) to the Hypercore peer layer under scope
       * "genius-core". Metadata only — NEVER raw edits or adapter bytes.
       * Runtime-gated by global `hyperEnabled`. Off by default.
       */
      hyperReplicationEnabled: z.boolean().optional(),
      /**
       * Absolute drop in eval score (0..1) that triggers auto-rollback of
       * a freshly distilled adapter. Set to 0 to disable. Default 0.05.
       */
      adapterRollbackThreshold: z.number().min(0).max(1).optional(),
      /**
       * Opt in to federated distillation: merge peer adapter receipts
       * observed on the Hypercore `genius-core` log into local context
       * slots. Requires `hyperReplicationEnabled` and `hyperEnabled`.
       */
      federatedDistillationEnabled: z.boolean().optional(),
      /**
       * Capable model used as a one-turn fallback when a Genius Core
       * turn requires tool/function calling (which Genius Core does not
       * natively support). When unset, tool-requiring turns simply
       * proceed against Genius Core and the model emits a plain-text
       * apology in place of tool calls.
       */
      toolCallFallback: z
        .object({
          provider: z.string(),
          modelName: z.string(),
        })
        .optional(),
    })
    .optional(),

  /**
   * Unified local-provider settings. Forward-looking home for per-provider
   * config (base URLs, enabled flags) that today lives scattered across
   * env vars and the top-level `geniusCore` block. All sub-blocks are
   * optional; absence means "fall back to the current behavior".
   *
   * When `localProviders.geniusCore` is set it WINS over the legacy
   * top-level `geniusCore` block — see `getGeniusCoreSettings()` in
   * `src/main/settings.ts`.
   */
  localProviders: z
    .object({
      ollama: z
        .object({
          enabled: z.boolean().optional(),
          baseUrl: z.string().optional(),
        })
        .optional(),
      lmstudio: z
        .object({
          enabled: z.boolean().optional(),
          baseUrl: z.string().optional(),
        })
        .optional(),
      geniusCore: z
        .object({
          enabled: z.boolean().optional(),
          vramBudgetGb: z.number().min(1).max(96).optional(),
          baseModelId: z.string().optional(),
          executionProvider: z
            .enum(["auto", "webgpu", "directml", "coreml", "cuda", "cpu"])
            .optional(),
          contextSlotsDir: z.string().optional(),
          slotHistoryKeepLast: z.number().int().min(0).optional(),
          npuOffloadEnabled: z.boolean().optional(),
          weightStreamingEnabled: z.boolean().optional(),
          keystrokeLoggerEnabled: z.boolean().optional(),
          keystrokeLoggerProjectOverrides: z
            .record(z.string(), z.boolean())
            .optional(),
          nightlyDistillationEnabled: z.boolean().optional(),
          hyperReplicationEnabled: z.boolean().optional(),
          adapterRollbackThreshold: z.number().min(0).max(1).optional(),
          federatedDistillationEnabled: z.boolean().optional(),
          toolCallFallback: z
            .object({
              provider: z.string(),
              modelName: z.string(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),

  ////////////////////////////////
  // DEPRECATED.
  ////////////////////////////////
  enableProSaverMode: z.boolean().optional(),
  joyBudget: JoyBudgetSchema.optional(),
  runtimeMode: RuntimeModeSchema.optional(),
});

/**
 * Type derived from the UserSettingsSchema
 */
export type UserSettings = z.infer<typeof UserSettingsSchema>;

/**
 * All Pro features are now free in JoyCreate
 * This function always returns true to enable all features
 */
export function isJoyProEnabled(_settings: UserSettings): boolean {
  return true; // All features are free in JoyCreate
}

/**
 * Check if user has a Pro API key (legacy, not required anymore)
 */
export function hasJoyKey(settings: UserSettings): boolean {
  return true; // All features work without a key in JoyCreate
}

export function isSupabaseConnected(settings: UserSettings | null): boolean {
  if (!settings) {
    return false;
  }
  return Boolean(
    settings.supabase?.accessToken ||
      (settings.supabase?.organizations &&
        Object.keys(settings.supabase.organizations).length > 0),
  );
}

export function isTurboEditsV2Enabled(settings: UserSettings): boolean {
  // Turbo Edits V2 now available for free in JoyCreate
  return Boolean(
    settings.enableProLazyEditsMode === true &&
      settings.proLazyEditsMode === "v2",
  );
}

// Define interfaces for the props
export interface SecurityRisk {
  type: "warning" | "danger";
  title: string;
  description: string;
}

export interface FileChange {
  name: string;
  path: string;
  summary: string;
  type: "write" | "rename" | "delete";
  isServerFunction: boolean;
}

export interface CodeProposal {
  type: "code-proposal";
  title: string;
  securityRisks: SecurityRisk[];
  filesChanged: FileChange[];
  packagesAdded: string[];
  sqlQueries: SqlQuery[];
}

export type SuggestedAction =
  | RestartAppAction
  | SummarizeInNewChatAction
  | RefactorFileAction
  | WriteCodeProperlyAction
  | RebuildAction
  | RestartAction
  | RefreshAction
  | KeepGoingAction;

export interface RestartAppAction {
  id: "restart-app";
}

export interface SummarizeInNewChatAction {
  id: "summarize-in-new-chat";
}

export interface WriteCodeProperlyAction {
  id: "write-code-properly";
}

export interface RefactorFileAction {
  id: "refactor-file";
  path: string;
}

export interface RebuildAction {
  id: "rebuild";
}

export interface RestartAction {
  id: "restart";
}

export interface RefreshAction {
  id: "refresh";
}

export interface KeepGoingAction {
  id: "keep-going";
}

export interface ActionProposal {
  type: "action-proposal";
  actions: SuggestedAction[];
}

export interface TipProposal {
  type: "tip-proposal";
  title: string;
  description: string;
}

export type Proposal = CodeProposal | ActionProposal | TipProposal;

export interface ProposalResult {
  proposal: Proposal;
  chatId: number;
  messageId: number;
}

export interface SqlQuery {
  content: string;
  description?: string;
}
