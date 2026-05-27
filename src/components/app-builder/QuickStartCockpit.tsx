/**
 * Quick Start Cockpit
 *
 * Lives at the top of the workspace home Quick Start tab. Lets the user:
 *   1. Pick a project-type chip (App / Website / Game / UI Skin / Agent UI / Mobile / Desktop)
 *   2. Open an "Advanced" disclosure to set framework, UI library, category,
 *      template, build-mode preset, style hints, deployment targets, and
 *      paste knowledge notes.
 *   3. Run the App Clarification Agent inline once they submit a prompt —
 *      the agent asks 1–4 follow-up questions when info is missing, then
 *      hands a refined brief back to the parent for `createApp` + chat.
 *
 * The cockpit is intentionally additive: if the user clears every chip and
 * submits with a long prompt, the agent will skip questioning and the legacy
 * single-shot flow is preserved.
 */

import { useState } from "react";
import { useAtom } from "jotai";
import {
  quickStartIntentAtom,
  quickStartConfigAtom,
} from "@/atoms/quickStartAtoms";
import type { QuickStartProjectType } from "@/ipc/app_clarification_client";
import {
  DEFAULT_DATA_LAYER_CONFIG,
  defaultDataLayerFor,
  type BlobStorageKind,
  type DataLayerConfig,
  type DataLayerKind,
  type ReadIndexKind,
  type ServerRuntimeKind,
} from "@/shared/data_layer_types";
import {
  Boxes,
  Globe,
  Gamepad2,
  Palette,
  Bot,
  Smartphone,
  Monitor,
  ChevronDown,
  ChevronUp,
  Sparkles,
  X,
  Loader2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { localTemplatesData } from "@/shared/templates";
import { cn } from "@/lib/utils";
import type {
  ClarificationState,
  ClarificationQuestion,
} from "@/hooks/useAppClarificationAgent";

// ---------------------------------------------------------------------------
// Project-type chips
// ---------------------------------------------------------------------------

interface ChipDef {
  type: QuickStartProjectType;
  label: string;
  Icon: typeof Boxes;
  hint: string;
}

const CHIPS: ChipDef[] = [
  { type: "app", label: "App", Icon: Boxes, hint: "Full web application with backend" },
  { type: "website", label: "Website", Icon: Globe, hint: "Marketing site, portfolio, blog" },
  { type: "game", label: "Game", Icon: Gamepad2, hint: "Browser game with canvas/WebGL" },
  { type: "ui-skin", label: "UI Skin", Icon: Palette, hint: "Theme/skin for an existing app" },
  { type: "agent-ui", label: "Agent UI", Icon: Bot, hint: "Chat or workflow surface for an AI agent" },
  { type: "mobile", label: "Mobile", Icon: Smartphone, hint: "Capacitor/iOS/Android export" },
  { type: "desktop", label: "Desktop", Icon: Monitor, hint: "Electron-style desktop app" },
];

// ---------------------------------------------------------------------------
// Static option lists for the advanced configurator
// ---------------------------------------------------------------------------

const FRAMEWORKS = ["react", "next", "vite", "remix", "astro"] as const;
const UI_LIBRARIES = ["shadcn", "material", "chakra", "tailwind", "custom"] as const;
const BUILD_MODES = [
  "chat",
  "agent",
  "plan",
  "visual",
  "code",
  "debug",
  "refactor",
  "test",
] as const;
const CATEGORIES = [
  "saas",
  "ecommerce",
  "marketplace",
  "dashboard",
  "landing-page",
  "portfolio",
  "blog",
  "social",
  "education",
  "finance",
  "healthcare",
  "productivity",
  "crm",
  "analytics",
  "ai-tool",
  "web3",
  "community",
  "gaming",
  "other",
] as const;
const DEPLOYMENT_TARGETS = ["web", "mobile", "desktop"] as const;

// ---------------------------------------------------------------------------
// Data + Backend Layer options (see src/shared/data_layer_types.ts)
// ---------------------------------------------------------------------------

interface DataLayerOption<T extends string> {
  value: T;
  label: string;
  hint: string;
}

const PRIMARY_STORES: DataLayerOption<DataLayerKind>[] = [
  { value: "none", label: "Local only", hint: "localStorage / IndexedDB" },
  { value: "supabase", label: "Supabase", hint: "Hosted Postgres + Auth + Storage" },
  { value: "tableland", label: "Tableland", hint: "Onchain SQL (NFT-owned tables)" },
  { value: "ceramic", label: "Ceramic", hint: "DID streams, ComposeDB" },
  { value: "gundb", label: "GunDB", hint: "Local-first p2p graph" },
  { value: "orbitdb", label: "OrbitDB", hint: "CRDT over IPFS" },
  { value: "weavedb", label: "WeaveDB", hint: "Permanent NoSQL on Arweave" },
];

const SERVER_RUNTIMES: DataLayerOption<ServerRuntimeKind>[] = [
  { value: "none", label: "None", hint: "Client-only — no server logic" },
  { value: "supabase-edge", label: "Supabase Edge", hint: "Deno edge functions" },
  { value: "vercel-functions", label: "Vercel Funcs", hint: "Edge/Node functions" },
  { value: "cloudflare-workers", label: "CF Workers", hint: "V8 isolates at the edge" },
  { value: "railway", label: "Railway", hint: "Long-running containers" },
  { value: "render", label: "Render", hint: "Long-running containers" },
  { value: "fly-io", label: "Fly.io", hint: "Multi-region edge containers" },
  { value: "aws-lambda", label: "AWS Lambda", hint: "AWS-native serverless" },
];

const READ_INDEXES: DataLayerOption<ReadIndexKind>[] = [
  { value: "none", label: "None", hint: "No indexed onchain reads" },
  { value: "goldsky", label: "Goldsky", hint: "Subgraph + Mirror" },
  { value: "thegraph", label: "The Graph", hint: "Decentralized subgraphs" },
];

const BLOB_STORES: DataLayerOption<BlobStorageKind>[] = [
  { value: "none", label: "None", hint: "No file uploads" },
  { value: "supabase-storage", label: "Supabase", hint: "Buckets + RLS" },
  { value: "ipfs-4everland", label: "IPFS (4ever)", hint: "Pinned IPFS via 4everland" },
  { value: "ipfs-helia", label: "IPFS (Helia)", hint: "Embedded Helia node" },
  { value: "arweave", label: "Arweave", hint: "Permanent storage" },
  { value: "celestia", label: "Celestia", hint: "Data availability blobs" },
];

interface FeatureDef {
  id: string;
  label: string;
  hint: string;
}

const FEATURES: FeatureDef[] = [
  { id: "auth", label: "Auth", hint: "Sign-in / sign-up flow" },
  { id: "database", label: "Database", hint: "Persistent storage layer" },
  { id: "payments", label: "Payments", hint: "Stripe / crypto checkout" },
  { id: "analytics", label: "Analytics", hint: "Event tracking & dashboards" },
  { id: "seo", label: "SEO", hint: "Meta tags, sitemap, OG images" },
  { id: "i18n", label: "i18n", hint: "Multi-language support" },
  { id: "realtime", label: "Realtime", hint: "WebSockets / live updates" },
  { id: "ai-agents", label: "AI Agents", hint: "Embedded AI assistants" },
  { id: "web3", label: "Web3", hint: "Wallet connect, smart contracts" },
  { id: "mobile-export", label: "Mobile Export", hint: "Capacitor iOS/Android build" },
  { id: "admin", label: "Admin Panel", hint: "Back-office dashboard" },
  { id: "notifications", label: "Notifications", hint: "Email / push alerts" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface QuickStartCockpitProps {
  clarification: ClarificationState;
  onAnswer: (text: string) => void;
  onCancel: () => void;
}

export function QuickStartCockpit({
  clarification,
  onAnswer,
  onCancel,
}: QuickStartCockpitProps) {
  const [intent, setIntent] = useAtom(quickStartIntentAtom);
  const [config, setConfig] = useAtom(quickStartConfigAtom);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const selectChip = (type: QuickStartProjectType) => {
    const next = intent === type ? null : type;
    setIntent(next);
    setConfig({ ...config, projectType: next ?? undefined });
  };

  return (
    <div className="w-full flex flex-col gap-3 mb-5">
      {/* Project-type chips */}
      <div className="flex flex-wrap gap-2 justify-center">
        {CHIPS.map(({ type, label, Icon, hint }) => {
          const active = intent === type;
          return (
            <button
              key={type}
              type="button"
              title={hint}
              onClick={() => selectChip(type)}
              className={cn(
                "group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all",
                active
                  ? "border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300 shadow-sm"
                  : "border-border/50 bg-background/60 hover:border-violet-500/30 hover:bg-violet-500/5 text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Advanced disclosure */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <div className="flex justify-center">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {advancedOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              Advanced (template, framework, knowledge…)
            </button>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="mt-3">
          <div className="rounded-xl border border-border/50 bg-background/60 backdrop-blur-sm p-4 grid gap-4 md:grid-cols-2">
            <ConfigSelect
              label="Template"
              value={config.templateId ?? ""}
              onChange={(v) =>
                setConfig({ ...config, templateId: v || undefined })
              }
              options={[
                { value: "", label: "(auto)" },
                ...localTemplatesData.map((t) => ({
                  value: t.id,
                  label: t.title,
                })),
              ]}
            />

            <ConfigSelect
              label="Framework"
              value={config.framework ?? ""}
              onChange={(v) =>
                setConfig({ ...config, framework: v || undefined })
              }
              options={FRAMEWORKS.map((f) => ({ value: f, label: f }))}
            />

            <ConfigSelect
              label="UI library"
              value={config.uiLibrary ?? ""}
              onChange={(v) =>
                setConfig({ ...config, uiLibrary: v || undefined })
              }
              options={UI_LIBRARIES.map((u) => ({ value: u, label: u }))}
            />

            <ConfigSelect
              label="App category"
              value={config.category ?? ""}
              onChange={(v) =>
                setConfig({ ...config, category: v || undefined })
              }
              options={[
                { value: "", label: "(auto)" },
                ...CATEGORIES.map((c) => ({ value: c, label: c })),
              ]}
            />

            <ConfigSelect
              label="Build mode"
              value={config.buildMode ?? "chat"}
              onChange={(v) => setConfig({ ...config, buildMode: v })}
              options={BUILD_MODES.map((b) => ({ value: b, label: b }))}
            />

            <div className="flex flex-col gap-1">
              <ConfigLabel>Deployment</ConfigLabel>
              <div className="flex flex-wrap gap-1.5">
                {DEPLOYMENT_TARGETS.map((t) => {
                  const active = (config.deploymentTargets ?? ["web"]).includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        const current = new Set(
                          config.deploymentTargets ?? ["web"],
                        );
                        if (current.has(t)) {
                          current.delete(t);
                        } else {
                          current.add(t);
                        }
                        setConfig({
                          ...config,
                          deploymentTargets:
                            current.size > 0 ? Array.from(current) : ["web"],
                        });
                      }}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-xs border transition-colors",
                        active
                          ? "border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                          : "border-border/50 text-muted-foreground hover:border-violet-500/30",
                      )}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Features (capability toggles) */}
            <div className="md:col-span-2 flex flex-col gap-1">
              <ConfigLabel>Include features</ConfigLabel>
              <div className="flex flex-wrap gap-1.5">
                {FEATURES.map((f) => {
                  const active = (config.features ?? []).includes(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      title={f.hint}
                      onClick={() => {
                        const set = new Set(config.features ?? []);
                        if (set.has(f.id)) {
                          set.delete(f.id);
                        } else {
                          set.add(f.id);
                        }
                        setConfig({ ...config, features: Array.from(set) });
                      }}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-xs border transition-colors",
                        active
                          ? "border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                          : "border-border/50 text-muted-foreground hover:border-violet-500/30",
                      )}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Style hints */}
            <div className="md:col-span-2 grid grid-cols-3 gap-2">
              <StyleField
                label="Color"
                placeholder="violet"
                value={config.styleHints?.color ?? ""}
                onChange={(v) =>
                  setConfig({
                    ...config,
                    styleHints: { ...config.styleHints, color: v || undefined },
                  })
                }
              />
              <StyleField
                label="Font"
                placeholder="Inter"
                value={config.styleHints?.font ?? ""}
                onChange={(v) =>
                  setConfig({
                    ...config,
                    styleHints: { ...config.styleHints, font: v || undefined },
                  })
                }
              />
              <StyleField
                label="Mood"
                placeholder="playful, dark, minimal…"
                value={config.styleHints?.mood ?? ""}
                onChange={(v) =>
                  setConfig({
                    ...config,
                    styleHints: { ...config.styleHints, mood: v || undefined },
                  })
                }
              />
            </div>

            {/* Knowledge notes */}
            <div className="md:col-span-2 flex flex-col gap-1">
              <ConfigLabel>Knowledge & references (optional)</ConfigLabel>
              <Textarea
                placeholder="Paste API docs, brand guidelines, key URLs, or feature lists the agent should know about…"
                value={config.knowledgeNotes ?? ""}
                onChange={(e) =>
                  setConfig({ ...config, knowledgeNotes: e.target.value })
                }
                className="min-h-[72px] text-sm"
              />
            </div>

            {/* Data + Backend Layer (orthogonal knobs) */}
            <DataLayerSection
              value={
                config.dataLayer ??
                (config.projectType
                  ? defaultDataLayerFor(config.projectType)
                  : DEFAULT_DATA_LAYER_CONFIG)
              }
              onChange={(next) => setConfig({ ...config, dataLayer: next })}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Inline clarification dialog */}
      <ClarificationPanel
        clarification={clarification}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfigLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
      {children}
    </label>
  );
}

function ConfigSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <ConfigLabel>{label}</ConfigLabel>
      <Select
        value={value || "__none__"}
        onValueChange={(v) => onChange(v === "__none__" ? "" : v)}
      >
        <SelectTrigger className="h-8 text-sm">
          <SelectValue placeholder="(auto)" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem
              key={o.value || "__none__"}
              value={o.value || "__none__"}
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function StyleField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ConfigLabel>{label}</ConfigLabel>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm"
      />
    </div>
  );
}

// Generic chip-row for a single data-layer knob.
function DataLayerChipRow<T extends string>({
  label,
  hint,
  value,
  options,
  onSelect,
}: {
  label: string;
  hint: string;
  value: T;
  options: DataLayerOption<T>[];
  onSelect: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <ConfigLabel>{label}</ConfigLabel>
        <span className="text-[10px] text-muted-foreground/70">{hint}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              title={o.hint}
              onClick={() => onSelect(o.value)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs border transition-colors",
                active
                  ? "border-violet-500/60 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                  : "border-border/50 text-muted-foreground hover:border-violet-500/30",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DataLayerSection({
  value,
  onChange,
}: {
  value: DataLayerConfig;
  onChange: (next: DataLayerConfig) => void;
}) {
  return (
    <div className="md:col-span-2 flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Data + Backend Layer
        </div>
        <span className="text-[10px] text-muted-foreground/70">
          Four independent knobs — defaults are project-type aware.
        </span>
      </div>
      <DataLayerChipRow
        label="Primary store"
        hint="Where structured app data lives"
        value={value.primaryStore}
        options={PRIMARY_STORES}
        onSelect={(v) => onChange({ ...value, primaryStore: v })}
      />
      <DataLayerChipRow
        label="Server runtime"
        hint="Where server-only logic runs (cron, webhooks, secrets)"
        value={value.serverRuntime}
        options={SERVER_RUNTIMES}
        onSelect={(v) => onChange({ ...value, serverRuntime: v })}
      />
      <DataLayerChipRow
        label="Read index"
        hint="Optional fast queryable index over onchain data"
        value={value.readIndex}
        options={READ_INDEXES}
        onSelect={(v) => onChange({ ...value, readIndex: v })}
      />
      <DataLayerChipRow
        label="Blob storage"
        hint="Where uploaded files live"
        value={value.blobStorage}
        options={BLOB_STORES}
        onSelect={(v) => onChange({ ...value, blobStorage: v })}
      />
    </div>
  );
}

function ClarificationPanel({
  clarification,
  onAnswer,
  onCancel,
}: {
  clarification: ClarificationState;
  onAnswer: (text: string) => void;
  onCancel: () => void;
}) {
  const { status, question, error } = clarification;

  if (status === "idle" || status === "ready") return null;

  if (status === "error") {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-700 dark:text-rose-300 flex items-start gap-2">
        <X className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Scoping agent error</div>
          <div className="text-xs opacity-80">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-violet-500/30 bg-gradient-to-br from-violet-500/5 via-background to-pink-500/5 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium text-violet-700 dark:text-violet-300">
          {status === "asking" ? (
            <Sparkles className="h-3.5 w-3.5" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
          {status === "asking"
            ? "Quick question to sharpen your build"
            : status === "starting"
              ? "Checking what you've got…"
              : status === "thinking"
                ? "Thinking…"
                : status === "cancelled"
                  ? "Stopped — building with what we have"
                  : "Working…"}
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Skip & build now
        </button>
      </div>

      {status === "asking" && question ? (
        <QuestionForm question={question} onAnswer={onAnswer} />
      ) : null}
    </div>
  );
}

function QuestionForm({
  question,
  onAnswer,
}: {
  question: ClarificationQuestion;
  onAnswer: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const allowFreeform = question.allowFreeform !== false;

  const submit = (text: string) => {
    if (!text.trim()) return;
    onAnswer(text.trim());
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium">{question.text}</div>
      {question.suggestions && question.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {question.suggestions.map((s) => (
            <Badge
              key={s}
              variant="secondary"
              className="cursor-pointer hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300"
              onClick={() => submit(s)}
            >
              {s}
            </Badge>
          ))}
        </div>
      )}
      {allowFreeform && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
          className="flex gap-2"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type your answer…"
            className="h-8 text-sm"
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!draft.trim()}>
            Send
          </Button>
        </form>
      )}
    </div>
  );
}
