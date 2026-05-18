import fs from "node:fs";
import path from "node:path";
import { getUserDataPath } from "../paths/paths";
import {
  UserSettingsSchema,
  type UserSettings,
  Secret,
  VertexProviderSetting,
} from "../lib/schemas";
import { safeStorage } from "electron";
import { v4 as uuidv4 } from "uuid";
import log from "electron-log";
import { DEFAULT_TEMPLATE_ID } from "@/shared/templates";
import { IS_TEST_BUILD } from "@/ipc/utils/test_utils";

const logger = log.scope("settings");

// IF YOU NEED TO UPDATE THIS, YOU'RE PROBABLY DOING SOMETHING WRONG!
// Need to maintain backwards compatibility!
const DEFAULT_SETTINGS: UserSettings = {
  selectedModel: {
    name: "auto",
    provider: "auto",
  },
  providerSettings: {},
  telemetryConsent: "unset",
  telemetryUserId: uuidv4(),
  hasRunBefore: false,
  experiments: {},
  enableProLazyEditsMode: true,
  enableProSmartFilesContextMode: true,
  autoApproveChanges: true,
  selectedChatMode: "build",
  enableAutoFixProblems: false,
  enableAutoUpdate: true,
  releaseChannel: "stable",
  selectedTemplateId: DEFAULT_TEMPLATE_ID,
  isRunning: false,
  lastKnownPerformance: undefined,
  geniusCore: {
    enabled: false,
    vramBudgetGb: 8,
    baseModelId: "phi-3-mini-4k-instruct-int4-onnx",
    executionProvider: "auto",
    npuOffloadEnabled: false,
    weightStreamingEnabled: false,
    keystrokeLoggerEnabled: false,
    nightlyDistillationEnabled: false,
    hyperReplicationEnabled: false,
    /**
     * Auto-rollback newly-trained adapter when its eval score is at least
     * this many points (absolute, [0, 1] scale) worse than the previous
     * applied score. 0 disables rollback. Default 0.05 (5 percentage points).
     */
    adapterRollbackThreshold: 0.05,
    /**
     * Opt in to federated distillation — periodically merge peer adapter
     * receipts observed on the Hypercore peer layer into the local
     * context slot. Requires `hyperReplicationEnabled` + `hyperEnabled`.
     * Off by default.
     */
    federatedDistillationEnabled: false,
  },
};

const SETTINGS_FILE = "user-settings.json";

export function getSettingsFilePath(): string {
  return path.join(getUserDataPath(), SETTINGS_FILE);
}

export function readSettings(): UserSettings {
  try {
    const filePath = getSettingsFilePath();
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      return DEFAULT_SETTINGS;
    }
    const rawSettings = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const combinedSettings: UserSettings = {
      ...DEFAULT_SETTINGS,
      ...rawSettings,
    };
    const supabase = combinedSettings.supabase;
    if (supabase) {
      // Decrypt legacy tokens (kept but ignored)
      if (supabase.refreshToken) {
        const encryptionType = supabase.refreshToken.encryptionType;
        if (encryptionType) {
          supabase.refreshToken = {
            value: decrypt(supabase.refreshToken),
            encryptionType,
          };
        }
      }
      if (supabase.accessToken) {
        const encryptionType = supabase.accessToken.encryptionType;
        if (encryptionType) {
          supabase.accessToken = {
            value: decrypt(supabase.accessToken),
            encryptionType,
          };
        }
      }
      // Decrypt tokens for each organization in the organizations map
      if (supabase.organizations) {
        for (const orgId in supabase.organizations) {
          const org = supabase.organizations[orgId];
          if (org.accessToken) {
            const encryptionType = org.accessToken.encryptionType;
            if (encryptionType) {
              org.accessToken = {
                value: decrypt(org.accessToken),
                encryptionType,
              };
            }
          }
          if (org.refreshToken) {
            const encryptionType = org.refreshToken.encryptionType;
            if (encryptionType) {
              org.refreshToken = {
                value: decrypt(org.refreshToken),
                encryptionType,
              };
            }
          }
        }
      }
    }
    const neon = combinedSettings.neon;
    if (neon) {
      if (neon.refreshToken) {
        const encryptionType = neon.refreshToken.encryptionType;
        if (encryptionType) {
          neon.refreshToken = {
            value: decrypt(neon.refreshToken),
            encryptionType,
          };
        }
      }
      if (neon.accessToken) {
        const encryptionType = neon.accessToken.encryptionType;
        if (encryptionType) {
          neon.accessToken = {
            value: decrypt(neon.accessToken),
            encryptionType,
          };
        }
      }
    }
    if (combinedSettings.githubAccessToken) {
      const encryptionType = combinedSettings.githubAccessToken.encryptionType;
      combinedSettings.githubAccessToken = {
        value: decrypt(combinedSettings.githubAccessToken),
        encryptionType,
      };
    }
    if (combinedSettings.huggingFaceToken) {
      const encryptionType = combinedSettings.huggingFaceToken.encryptionType;
      combinedSettings.huggingFaceToken = {
        value: decrypt(combinedSettings.huggingFaceToken),
        encryptionType,
      };
    }
    if (combinedSettings.vercelAccessToken) {
      const encryptionType = combinedSettings.vercelAccessToken.encryptionType;
      combinedSettings.vercelAccessToken = {
        value: decrypt(combinedSettings.vercelAccessToken),
        encryptionType,
      };
    }
    for (const provider in combinedSettings.providerSettings) {
      if (combinedSettings.providerSettings[provider].apiKey) {
        const encryptionType =
          combinedSettings.providerSettings[provider].apiKey.encryptionType;
        combinedSettings.providerSettings[provider].apiKey = {
          value: decrypt(combinedSettings.providerSettings[provider].apiKey),
          encryptionType,
        };
      }
      // Decrypt Vertex service account key if present
      const v = combinedSettings.providerSettings[
        provider
      ] as VertexProviderSetting;
      if (provider === "vertex" && v?.serviceAccountKey) {
        const encryptionType = v.serviceAccountKey.encryptionType;
        v.serviceAccountKey = {
          value: decrypt(v.serviceAccountKey),
          encryptionType,
        };
      }
    }

    // Validate and merge with defaults
    const validatedSettings = UserSettingsSchema.parse(combinedSettings);
    // "conservative" is deprecated, use undefined to use the default value
    if (validatedSettings.proSmartContextOption === "conservative") {
      validatedSettings.proSmartContextOption = undefined;
    }
    return validatedSettings;
  } catch (error) {
    logger.error("Error reading settings:", error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Resolve the effective Genius Core configuration, preferring the new
 * unified `localProviders.geniusCore` block when present and falling back
 * to the legacy top-level `geniusCore` block otherwise. Fields are
 * merged shallowly with the new block winning per-key so partial
 * overrides work — eg. flipping just `enabled` on the new block.
 *
 * Always returns a defined object (never undefined) so callers can read
 * `getGeniusCoreSettings().enabled` without optional chaining.
 */
export function getGeniusCoreSettings(): NonNullable<
  UserSettings["geniusCore"]
> {
  const s = readSettings();
  const legacy = s.geniusCore;
  const next = s.localProviders?.geniusCore;
  const merged = { ...(legacy ?? {}), ...(next ?? {}) };
  return {
    enabled: merged.enabled ?? false,
    vramBudgetGb: merged.vramBudgetGb ?? 8,
    baseModelId: merged.baseModelId ?? "phi-3-mini-4k-instruct-int4-onnx",
    executionProvider: merged.executionProvider ?? "auto",
    contextSlotsDir: merged.contextSlotsDir,
    slotHistoryKeepLast: merged.slotHistoryKeepLast,
    npuOffloadEnabled: merged.npuOffloadEnabled ?? false,
    weightStreamingEnabled: merged.weightStreamingEnabled ?? false,
    keystrokeLoggerEnabled: merged.keystrokeLoggerEnabled ?? false,
    keystrokeLoggerProjectOverrides: merged.keystrokeLoggerProjectOverrides,
    nightlyDistillationEnabled: merged.nightlyDistillationEnabled ?? false,
    hyperReplicationEnabled: merged.hyperReplicationEnabled,
    adapterRollbackThreshold: merged.adapterRollbackThreshold,
    federatedDistillationEnabled: merged.federatedDistillationEnabled,
    toolCallFallback: merged.toolCallFallback,
  };
}

export function writeSettings(settings: Partial<UserSettings>): void {
  try {
    const filePath = getSettingsFilePath();
    const currentSettings = readSettings();
    const newSettings = { ...currentSettings, ...settings };
    if (newSettings.githubAccessToken) {
      newSettings.githubAccessToken = encrypt(
        newSettings.githubAccessToken.value,
      );
    }
    if (newSettings.huggingFaceToken) {
      newSettings.huggingFaceToken = encrypt(
        newSettings.huggingFaceToken.value,
      );
    }
    if (newSettings.vercelAccessToken) {
      newSettings.vercelAccessToken = encrypt(
        newSettings.vercelAccessToken.value,
      );
    }
    if (newSettings.supabase) {
      // Encrypt legacy tokens (kept for backwards compat)
      if (newSettings.supabase.accessToken) {
        newSettings.supabase.accessToken = encrypt(
          newSettings.supabase.accessToken.value,
        );
      }
      if (newSettings.supabase.refreshToken) {
        newSettings.supabase.refreshToken = encrypt(
          newSettings.supabase.refreshToken.value,
        );
      }
      // Encrypt tokens for each organization in the organizations map
      if (newSettings.supabase.organizations) {
        for (const orgId in newSettings.supabase.organizations) {
          const org = newSettings.supabase.organizations[orgId];
          if (org.accessToken) {
            org.accessToken = encrypt(org.accessToken.value);
          }
          if (org.refreshToken) {
            org.refreshToken = encrypt(org.refreshToken.value);
          }
        }
      }
    }
    if (newSettings.neon) {
      if (newSettings.neon.accessToken) {
        newSettings.neon.accessToken = encrypt(
          newSettings.neon.accessToken.value,
        );
      }
      if (newSettings.neon.refreshToken) {
        newSettings.neon.refreshToken = encrypt(
          newSettings.neon.refreshToken.value,
        );
      }
    }
    for (const provider in newSettings.providerSettings) {
      if (newSettings.providerSettings[provider].apiKey) {
        newSettings.providerSettings[provider].apiKey = encrypt(
          newSettings.providerSettings[provider].apiKey.value,
        );
      }
      // Encrypt Vertex service account key if present
      const v = newSettings.providerSettings[provider] as VertexProviderSetting;
      if (provider === "vertex" && v?.serviceAccountKey) {
        v.serviceAccountKey = encrypt(v.serviceAccountKey.value);
      }
    }
    const validatedSettings = UserSettingsSchema.parse(newSettings);
    fs.writeFileSync(filePath, JSON.stringify(validatedSettings, null, 2));
  } catch (error) {
    logger.error("Error writing settings:", error);
  }
}

export function encrypt(data: string): Secret {
  if (safeStorage.isEncryptionAvailable() && !IS_TEST_BUILD) {
    return {
      value: safeStorage.encryptString(data).toString("base64"),
      encryptionType: "electron-safe-storage",
    };
  }
  return {
    value: data,
    encryptionType: "plaintext",
  };
}

export function decrypt(data: Secret): string {
  if (data.encryptionType === "electron-safe-storage") {
    return safeStorage.decryptString(Buffer.from(data.value, "base64"));
  }
  return data.value;
}
