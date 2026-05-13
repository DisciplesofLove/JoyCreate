/**
 * Model Catalog Watchdog
 * ----------------------
 * Periodically polls each configured cloud LLM provider's `/models` endpoint
 * and upserts any newly-released models into the `language_models` table so
 * builder dropdowns, agent editors, and the orchestrator always see the
 * latest available checkpoints without requiring a JoyCreate release.
 *
 * Behavior:
 *  - On startup (after a short delay) and every {@link REFRESH_INTERVAL_MS},
 *    iterates the cloud providers in `language_model_constants.MODEL_OPTIONS`.
 *  - For each provider with an API key (from user settings or env var), it
 *    calls the provider's models endpoint, normalizes the response, and
 *    upserts rows into `language_models` with `builtinProviderId` set so the
 *    existing `getLanguageModels(...)` helper merges them with hardcoded
 *    entries.
 *  - Models already present in `MODEL_OPTIONS` (hardcoded) are skipped to
 *    avoid duplicate display.
 *  - Failures are logged but never thrown — the watchdog is best-effort.
 *
 * Manual trigger: `refreshModelCatalog()` is exported and wired to an IPC
 * handler (`models:refresh-catalog`) so the settings UI can offer a
 * "Refresh model list" button.
 */

import log from "electron-log";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { language_models as languageModelsSchema } from "@/db/schema";
import { MODEL_OPTIONS, PROVIDER_TO_ENV_VAR } from "@/ipc/shared/language_model_constants";
import { readSettings } from "@/main/settings";

const logger = log.scope("model_catalog_watchdog");

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 30_000; // wait for app init to settle

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let initialKick: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

export interface ProviderRefreshResult {
  providerId: string;
  discovered: number;
  added: number;
  skipped: number;
  error?: string;
}

/**
 * Start the watchdog. Idempotent — calling twice is a no-op.
 */
export function startModelCatalogWatchdog(): void {
  if (watchdogTimer) return;

  initialKick = setTimeout(() => {
    void refreshModelCatalog().catch((err) =>
      logger.warn(`Initial model catalog refresh failed: ${(err as Error).message}`),
    );
  }, INITIAL_DELAY_MS);

  watchdogTimer = setInterval(() => {
    void refreshModelCatalog().catch((err) =>
      logger.warn(`Scheduled model catalog refresh failed: ${(err as Error).message}`),
    );
  }, REFRESH_INTERVAL_MS);

  logger.info(
    `Model catalog watchdog started (initial in ${INITIAL_DELAY_MS / 1000}s, then every ${REFRESH_INTERVAL_MS / 3_600_000}h)`,
  );
}

/**
 * Stop the watchdog. Used by tests and app teardown.
 */
export function stopModelCatalogWatchdog(): void {
  if (initialKick) {
    clearTimeout(initialKick);
    initialKick = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/**
 * Refresh the catalog for every provider with a configured API key.
 * Always resolves — per-provider failures are captured in the returned array.
 */
export async function refreshModelCatalog(): Promise<ProviderRefreshResult[]> {
  if (inFlight) {
    logger.debug("Refresh already in progress, skipping");
    return [];
  }
  inFlight = true;

  try {
    const results: ProviderRefreshResult[] = [];
    const providerIds: ProviderId[] = ["openai", "anthropic", "google", "xai", "openrouter"];

    for (const providerId of providerIds) {
      const apiKey = resolveApiKey(providerId);
      if (!apiKey) {
        logger.debug(`Skipping ${providerId}: no API key`);
        continue;
      }
      try {
        const result = await refreshProvider(providerId, apiKey);
        results.push(result);
        if (result.added > 0) {
          logger.info(
            `${providerId}: discovered ${result.discovered}, added ${result.added} new model(s)`,
          );
        }
      } catch (err) {
        const message = (err as Error).message;
        logger.warn(`Refresh failed for ${providerId}: ${message}`);
        results.push({
          providerId,
          discovered: 0,
          added: 0,
          skipped: 0,
          error: message,
        });
      }
    }
    return results;
  } finally {
    inFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Provider-specific fetchers
// ---------------------------------------------------------------------------

type ProviderId = "openai" | "anthropic" | "google" | "xai" | "openrouter";

interface DiscoveredModel {
  apiName: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

async function refreshProvider(
  providerId: ProviderId,
  apiKey: string,
): Promise<ProviderRefreshResult> {
  const discovered = await fetchProviderModels(providerId, apiKey);

  // Build a set of hardcoded apiNames so we don't duplicate the curated list.
  const hardcodedNames = new Set(
    (MODEL_OPTIONS[providerId] ?? []).map((m) => m.name),
  );

  let added = 0;
  let skipped = 0;

  for (const model of discovered) {
    if (hardcodedNames.has(model.apiName)) {
      skipped++;
      continue;
    }

    // Upsert by (builtinProviderId, apiName).
    const existing = await db
      .select({ id: languageModelsSchema.id })
      .from(languageModelsSchema)
      .where(
        and(
          eq(languageModelsSchema.builtinProviderId, providerId),
          eq(languageModelsSchema.apiName, model.apiName),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Already known — bump updatedAt only.
      await db
        .update(languageModelsSchema)
        .set({ updatedAt: new Date() })
        .where(eq(languageModelsSchema.id, existing[0].id));
      skipped++;
    } else {
      await db.insert(languageModelsSchema).values({
        builtinProviderId: providerId,
        apiName: model.apiName,
        displayName: model.displayName,
        description: model.description ?? "Auto-discovered from provider API",
        max_output_tokens: model.maxOutputTokens ?? null,
        context_window: model.contextWindow ?? null,
      });
      added++;
    }
  }

  return { providerId, discovered: discovered.length, added, skipped };
}

async function fetchProviderModels(
  providerId: ProviderId,
  apiKey: string,
): Promise<DiscoveredModel[]> {
  switch (providerId) {
    case "openai":
      return fetchOpenAI(apiKey);
    case "anthropic":
      return fetchAnthropic(apiKey);
    case "google":
      return fetchGoogle(apiKey);
    case "xai":
      return fetchXai(apiKey);
    case "openrouter":
      return fetchOpenRouter(apiKey);
    default:
      return [];
  }
}

/** OpenAI: GET https://api.openai.com/v1/models */
async function fetchOpenAI(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI /models ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data: Array<{ id: string }> };
  // Only chat / GPT-family models (skip embeddings, audio, image, moderation).
  return body.data
    .filter((m) => /^(gpt-|o[1-9]|chatgpt-)/i.test(m.id))
    .map((m) => ({
      apiName: m.id,
      displayName: prettifyId(m.id),
    }));
}

/** Anthropic: GET https://api.anthropic.com/v1/models */
async function fetchAnthropic(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) {
    throw new Error(`Anthropic /models ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data: Array<{ id: string; display_name?: string }>;
  };
  return body.data
    .filter((m) => m.id.startsWith("claude-"))
    .map((m) => ({
      apiName: m.id,
      displayName: m.display_name ?? prettifyId(m.id),
      contextWindow: 200_000,
    }));
}

/** Google: GET https://generativelanguage.googleapis.com/v1beta/models?key=... */
async function fetchGoogle(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) {
    throw new Error(`Google /models ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    models: Array<{
      name: string;
      displayName?: string;
      description?: string;
      inputTokenLimit?: number;
      outputTokenLimit?: number;
      supportedGenerationMethods?: string[];
    }>;
  };
  return body.models
    .filter(
      (m) =>
        m.name.includes("gemini") &&
        (m.supportedGenerationMethods ?? []).includes("generateContent"),
    )
    .map((m) => ({
      // API returns "models/gemini-…"; strip the prefix for apiName.
      apiName: m.name.replace(/^models\//, ""),
      displayName: m.displayName ?? prettifyId(m.name),
      description: m.description,
      contextWindow: m.inputTokenLimit,
      maxOutputTokens: m.outputTokenLimit,
    }));
}

/** xAI: GET https://api.x.ai/v1/models */
async function fetchXai(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`xAI /models ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data.map((m) => ({
    apiName: m.id,
    displayName: prettifyId(m.id),
  }));
}

/** OpenRouter: GET https://openrouter.ai/api/v1/models */
async function fetchOpenRouter(apiKey: string): Promise<DiscoveredModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    data: Array<{
      id: string;
      name?: string;
      description?: string;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number };
    }>;
  };
  // OpenRouter has thousands of models; cap to the top ~200 by listing order
  // (newest first) to keep the dropdown manageable.
  return body.data.slice(0, 200).map((m) => ({
    apiName: m.id,
    displayName: m.name ?? prettifyId(m.id),
    description: m.description,
    contextWindow: m.context_length,
    maxOutputTokens: m.top_provider?.max_completion_tokens,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveApiKey(providerId: ProviderId): string | undefined {
  // 1. user settings
  try {
    const settings = readSettings();
    const ps = settings.providerSettings?.[providerId];
    const fromSettings =
      ps && "apiKey" in ps ? (ps as { apiKey?: { value?: string } }).apiKey?.value : undefined;
    if (fromSettings) return fromSettings;
  } catch (err) {
    logger.debug(`readSettings failed: ${(err as Error).message}`);
  }

  // 2. env var fallback
  const envVar = PROVIDER_TO_ENV_VAR[providerId as keyof typeof PROVIDER_TO_ENV_VAR];
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (fromEnv) return fromEnv;
  }

  return undefined;
}

function prettifyId(id: string): string {
  return id
    .replace(/^models\//, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
