/**
 * Privacy Settings Page — Phase 7 of the JoyCreate completion plan.
 *
 * Surfaces the `PRIVACY_PROFILES` and `ROUTING_PROFILES` presets that already
 * live in `src/types/privacy_inference_types.ts` and lets the user pick a
 * default for the inference bridge. Also exposes the field-level toggles
 * (encryption, hashing, peer/cost limits) for power users.
 *
 * Read/write surface: `useInferenceBridgeConfig()` + `useUpdateInferenceBridgeConfig()`
 * (already wired through `privacy-inference:get-config` / `:update-config`).
 */

import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Shield, Network, Lock, AlertTriangle, Check } from "lucide-react";
import {
  useInferenceBridgeConfig,
  useUpdateInferenceBridgeConfig,
} from "@/hooks/usePrivacyInference";
import {
  PRIVACY_PROFILES,
  ROUTING_PROFILES,
  type InferencePrivacyConfig,
  type InferenceRoutingConfig,
  type PrivacyLevel,
  type DataHandling,
} from "@/types/privacy_inference_types";
import { showError, showSuccess } from "@/lib/toast";

const PRIVACY_PROFILE_META: Record<
  keyof typeof PRIVACY_PROFILES,
  { title: string; description: string; tone: string }
> = {
  MAXIMUM: {
    title: "Maximum",
    description:
      "Never leaves the device. No hashes, no metrics, no model IDs shared.",
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  HIGH: {
    title: "High",
    description:
      "Local preferred with verification. Only sha256 hashes leave the device.",
    tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  STANDARD: {
    title: "Standard",
    description:
      "Federated peers allowed with end-to-end encryption and key rotation.",
    tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
  BALANCED: {
    title: "Balanced",
    description:
      "Hybrid local/federated for performance. Encryption in transit only.",
    tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
};

const ROUTING_PROFILE_META: Record<
  keyof typeof ROUTING_PROFILES,
  { title: string; description: string; tone: string }
> = {
  LOCAL_ONLY: {
    title: "Local only",
    description: "Never use the network — local model, adapter, or agent only.",
    tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  PRIVACY_FIRST: {
    title: "Privacy first",
    description:
      "Local first, then trusted peers with high reputation (≥90) and uptime (≥95%).",
    tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  PERFORMANCE: {
    title: "Performance",
    description: "Fastest available executor — local, adapter, peer, or agent.",
    tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  COST_OPTIMIZED: {
    title: "Cost optimized",
    description: "Cheapest option first, max 10¢ per request.",
    tone: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
  },
};

function shallowMatch<T extends Record<string, unknown>>(
  preset: T,
  actual: Record<string, unknown> | undefined,
): boolean {
  if (!actual) return false;
  return Object.entries(preset).every(([k, v]) => {
    const av = actual[k];
    if (Array.isArray(v) || typeof v === "object") {
      return JSON.stringify(av) === JSON.stringify(v);
    }
    return av === v;
  });
}

export default function PrivacySettingsPage() {
  const { data: config, isLoading } = useInferenceBridgeConfig();
  const updateConfig = useUpdateInferenceBridgeConfig();

  // Local working copy so users can edit field-level toggles before saving.
  const [draft, setDraft] = useState<{
    privacy: InferencePrivacyConfig;
    routing: InferenceRoutingConfig;
    enableFederation: boolean;
    maxPeerConnections: number;
  } | null>(null);

  useEffect(() => {
    if (config && !draft) {
      setDraft({
        privacy: { ...config.defaultPrivacy },
        routing: { ...config.defaultRouting },
        enableFederation: config.enableFederation,
        maxPeerConnections: config.maxPeerConnections,
      });
    }
  }, [config, draft]);

  const activePrivacyPreset = useMemo(() => {
    if (!draft) return null;
    return (Object.keys(PRIVACY_PROFILES) as Array<keyof typeof PRIVACY_PROFILES>).find(
      (k) =>
        shallowMatch(
          PRIVACY_PROFILES[k] as unknown as Record<string, unknown>,
          draft.privacy as unknown as Record<string, unknown>,
        ),
    ) ?? null;
  }, [draft]);

  const activeRoutingPreset = useMemo(() => {
    if (!draft) return null;
    return (Object.keys(ROUTING_PROFILES) as Array<keyof typeof ROUTING_PROFILES>).find(
      (k) =>
        shallowMatch(
          ROUTING_PROFILES[k] as unknown as Record<string, unknown>,
          draft.routing as unknown as Record<string, unknown>,
        ),
    ) ?? null;
  }, [draft]);

  const applyPrivacyPreset = (key: keyof typeof PRIVACY_PROFILES) => {
    if (!draft) return;
    setDraft({
      ...draft,
      privacy: {
        ...draft.privacy,
        ...(PRIVACY_PROFILES[key] as unknown as Partial<InferencePrivacyConfig>),
      },
    });
  };

  const applyRoutingPreset = (key: keyof typeof ROUTING_PROFILES) => {
    if (!draft) return;
    setDraft({
      ...draft,
      routing: {
        ...draft.routing,
        ...(ROUTING_PROFILES[key] as unknown as Partial<InferenceRoutingConfig>),
      },
    });
  };

  const save = async () => {
    if (!draft) return;
    try {
      await updateConfig.mutateAsync({
        defaultPrivacy: draft.privacy,
        defaultRouting: draft.routing,
        enableFederation: draft.enableFederation,
        maxPeerConnections: draft.maxPeerConnections,
      });
      showSuccess("Privacy settings saved");
    } catch (err) {
      showError(err);
    }
  };

  if (isLoading || !draft) {
    return (
      <div className="flex min-h-full w-full flex-col gap-6 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-full w-full flex-col gap-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Shield className="h-6 w-6 text-emerald-500" />
          Privacy & Inference Routing
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control how your prompts, responses, and metadata are handled across
          local models, trusted peers, and the JoyCreate federation. Defaults
          apply to every inference request unless an agent overrides them.
        </p>
      </div>

      {/* Privacy profile picker */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Privacy profile
            {activePrivacyPreset ? (
              <Badge variant="secondary" className="ml-2">
                {PRIVACY_PROFILE_META[activePrivacyPreset].title}
              </Badge>
            ) : (
              <Badge variant="outline" className="ml-2">
                Custom
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Pick a preset or fine-tune the toggles below.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(Object.keys(PRIVACY_PROFILES) as Array<keyof typeof PRIVACY_PROFILES>).map(
            (key) => {
              const meta = PRIVACY_PROFILE_META[key];
              const isActive = activePrivacyPreset === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPrivacyPreset(key)}
                  className={`flex w-full flex-col items-start gap-2 rounded-lg border p-4 text-left transition hover:bg-muted/40 ${
                    isActive ? "border-primary ring-2 ring-primary/40" : "border-border"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className={meta.tone}>
                      {meta.title}
                    </Badge>
                    {isActive && <Check className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="text-sm text-muted-foreground">{meta.description}</p>
                </button>
              );
            },
          )}
        </CardContent>
      </Card>

      {/* Privacy toggles */}
      <Card>
        <CardHeader>
          <CardTitle>Privacy controls</CardTitle>
          <CardDescription>
            Field-level toggles applied on top of the selected profile.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SelectField
              label="Privacy level"
              value={draft.privacy.level}
              options={[
                ["local_only", "Local only"],
                ["local_preferred", "Local preferred"],
                ["federated", "Federated"],
                ["hybrid", "Hybrid"],
                ["any", "Any (not recommended)"],
              ]}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  privacy: { ...draft.privacy, level: v as PrivacyLevel },
                })
              }
            />
            <SelectField
              label="Data handling"
              value={draft.privacy.dataHandling}
              options={[
                ["never_share", "Never share"],
                ["hash_only", "Hash only"],
                ["encrypted", "Encrypted"],
                ["attestation", "Attestation"],
                ["full", "Full (self-hosted only)"],
              ]}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  privacy: {
                    ...draft.privacy,
                    dataHandling: v as DataHandling,
                  },
                })
              }
            />
          </div>

          <Separator />

          <ToggleRow
            label="Allow prompt hashing"
            description="Share SHA-256 of prompts for receipts and rate limiting."
            checked={draft.privacy.allowPromptHashing}
            onChange={(v) =>
              setDraft({
                ...draft,
                privacy: { ...draft.privacy, allowPromptHashing: v },
              })
            }
          />
          <ToggleRow
            label="Allow response hashing"
            description="Share SHA-256 of responses so peers can verify outputs."
            checked={draft.privacy.allowResponseHashing}
            onChange={(v) =>
              setDraft({
                ...draft,
                privacy: { ...draft.privacy, allowResponseHashing: v },
              })
            }
          />
          <ToggleRow
            label="Allow metric sharing"
            description="Share anonymous timing and token-count metrics."
            checked={draft.privacy.allowMetricSharing}
            onChange={(v) =>
              setDraft({
                ...draft,
                privacy: { ...draft.privacy, allowMetricSharing: v },
              })
            }
          />
          <ToggleRow
            label="Allow model ID sharing"
            description="Share which model handled the request."
            checked={draft.privacy.allowModelIdSharing}
            onChange={(v) =>
              setDraft({
                ...draft,
                privacy: { ...draft.privacy, allowModelIdSharing: v },
              })
            }
          />
          <ToggleRow
            label="Encrypt in transit"
            description="Required for any peer interaction."
            checked={draft.privacy.encryptInTransit}
            onChange={(v) =>
              setDraft({
                ...draft,
                privacy: { ...draft.privacy, encryptInTransit: v },
              })
            }
          />
          <ToggleRow
            label="Encrypt at rest"
            description="Encrypt locally-stored prompts, responses, and receipts."
            checked={draft.privacy.encryptAtRest}
            onChange={(v) =>
              setDraft({
                ...draft,
                privacy: { ...draft.privacy, encryptAtRest: v },
              })
            }
          />
          <ToggleRow
            label="Key rotation"
            description="Periodically rotate encryption keys."
            checked={draft.privacy.keyRotationEnabled}
            onChange={(v) =>
              setDraft({
                ...draft,
                privacy: { ...draft.privacy, keyRotationEnabled: v },
              })
            }
          />

          {draft.privacy.level === "any" && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <span>
                <strong>Any</strong> places no restrictions on where your data
                may travel. Only use this with self-hosted infrastructure you
                fully trust.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Routing profile picker */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            Routing profile
            {activeRoutingPreset ? (
              <Badge variant="secondary" className="ml-2">
                {ROUTING_PROFILE_META[activeRoutingPreset].title}
              </Badge>
            ) : (
              <Badge variant="outline" className="ml-2">
                Custom
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            How requests are dispatched across local, adapter, peer, and agent
            executors.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(Object.keys(ROUTING_PROFILES) as Array<keyof typeof ROUTING_PROFILES>).map(
            (key) => {
              const meta = ROUTING_PROFILE_META[key];
              const isActive = activeRoutingPreset === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyRoutingPreset(key)}
                  className={`flex w-full flex-col items-start gap-2 rounded-lg border p-4 text-left transition hover:bg-muted/40 ${
                    isActive ? "border-primary ring-2 ring-primary/40" : "border-border"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className={meta.tone}>
                      {meta.title}
                    </Badge>
                    {isActive && <Check className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="text-sm text-muted-foreground">{meta.description}</p>
                </button>
              );
            },
          )}
        </CardContent>
      </Card>

      {/* Federation toggle */}
      <Card>
        <CardHeader>
          <CardTitle>Federation</CardTitle>
          <CardDescription>
            Enable peer-to-peer inference across the JoyCreate federation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            label="Enable federation"
            description="Allow inference requests to be routed to trusted peers."
            checked={draft.enableFederation}
            onChange={(v) => setDraft({ ...draft, enableFederation: v })}
          />
          <div className="space-y-1">
            <Label htmlFor="max-peers">Max peer connections</Label>
            <Input
              id="max-peers"
              type="number"
              min={0}
              max={500}
              value={draft.maxPeerConnections}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  maxPeerConnections: Math.max(0, Number(e.target.value || 0)),
                })
              }
              className="w-32"
            />
          </div>
        </CardContent>
      </Card>

      <div className="sticky bottom-4 flex items-center justify-end gap-2 rounded-lg border bg-background/80 p-3 backdrop-blur">
        <Button
          variant="ghost"
          onClick={() => {
            if (config) {
              setDraft({
                privacy: { ...config.defaultPrivacy },
                routing: { ...config.defaultRouting },
                enableFederation: config.enableFederation,
                maxPeerConnections: config.maxPeerConnections,
              });
            }
          }}
          disabled={updateConfig.isPending}
        >
          Reset
        </Button>
        <Button onClick={save} disabled={updateConfig.isPending}>
          {updateConfig.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
