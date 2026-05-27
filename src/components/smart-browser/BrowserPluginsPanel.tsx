/**
 * BrowserPluginsPanel — side-panel UI to view, toggle, build, and remove
 * Smart Browser plugins. Lives in the SmartBrowserPage side panel tabs.
 */

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Puzzle,
  Plus,
  Sparkles,
  Trash2,
  Play,
  Loader2,
  Code2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  useBrowserPlugins,
  useBuildBrowserPlugin,
  useDeleteBrowserPlugin,
  useSaveBrowserPlugin,
  useToggleBrowserPlugin,
} from "@/hooks/useBrowserPlugins";
import type {
  BrowserPlugin,
  BrowserPluginType,
} from "@/types/browser_plugin";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface Props {
  currentUrl?: string;
  /** Run the plugin's code in the active webview and return its result. */
  runPluginInActiveWebview?: (plugin: BrowserPlugin) => Promise<unknown>;
}

export function BrowserPluginsPanel({
  currentUrl,
  runPluginInActiveWebview,
}: Props) {
  const { data: plugins = [], isLoading } = useBrowserPlugins();
  const toggle = useToggleBrowserPlugin();
  const remove = useDeleteBrowserPlugin();
  const save = useSaveBrowserPlugin();
  const build = useBuildBrowserPlugin();

  const [mode, setMode] = useState<"list" | "create" | "ai">("list");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [widgetResult, setWidgetResult] = useState<
    Record<string, { ok: boolean; text: string } | undefined>
  >({});

  const runWidget = useCallback(
    async (p: BrowserPlugin) => {
      if (!runPluginInActiveWebview) return;
      try {
        const raw = await runPluginInActiveWebview(p);
        const text =
          typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
        setWidgetResult((r) => ({
          ...r,
          [p.id]: { ok: true, text: text || "(no output)" },
        }));
      } catch (err) {
        setWidgetResult((r) => ({
          ...r,
          [p.id]: { ok: false, text: (err as Error).message },
        }));
      }
    },
    [runPluginInActiveWebview],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-border/50 bg-background/95 backdrop-blur flex items-center gap-2">
        <Puzzle className="h-4 w-4 text-emerald-500" />
        <span className="font-semibold text-sm">Browser Plugins</span>
        <Badge variant="secondary" className="text-[10px] ml-1">
          {plugins.length}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setMode("ai")}
            title="Generate a plugin with AI"
          >
            <Sparkles className="h-3.5 w-3.5 text-violet-500" />
            Build with AI
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setMode("create")}
            title="Create a plugin manually"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {mode === "ai" && (
          <AiBuilder
            currentUrl={currentUrl}
            onCancel={() => setMode("list")}
            onBuilt={async (draft) => {
              await save.mutateAsync({
                name: draft.name,
                description: draft.description,
                type: draft.type,
                code: draft.code,
                promptTemplate: draft.promptTemplate,
                icon: draft.icon,
                author: "ai",
                enabled: true,
              });
              setMode("list");
            }}
            buildPending={build.isPending}
            savePending={save.isPending}
            buildAsync={(p) => build.mutateAsync(p)}
          />
        )}

        {mode === "create" && (
          <ManualCreator
            onCancel={() => setMode("list")}
            onSubmit={async (req) => {
              await save.mutateAsync(req);
              setMode("list");
            }}
            saving={save.isPending}
          />
        )}

        {mode === "list" && (
          <div className="p-3 space-y-2">
            {isLoading ? (
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading plugins…
              </div>
            ) : plugins.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center mt-8 space-y-2">
                <Puzzle className="h-6 w-6 mx-auto text-emerald-500/60" />
                <p>
                  No plugins yet. Click <b>Build with AI</b> to describe one
                  in plain English.
                </p>
              </div>
            ) : (
              plugins.map((p) => {
                const isOpen = expanded === p.id;
                const result = widgetResult[p.id];
                return (
                  <div
                    key={p.id}
                    className={cn(
                      "rounded-lg border border-border/50 bg-card/40",
                      !p.enabled && "opacity-60",
                    )}
                  >
                    <div className="flex items-start gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : p.id)}
                        className="mt-0.5 text-muted-foreground hover:text-foreground"
                        aria-label={isOpen ? "Collapse" : "Expand"}
                      >
                        {isOpen ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">
                            {p.name}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1 py-0"
                          >
                            {p.type}
                          </Badge>
                          {p.builtin && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1 py-0"
                            >
                              built-in
                            </Badge>
                          )}
                          {p.author === "ai" && (
                            <Badge className="text-[10px] px-1 py-0 bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30">
                              AI
                            </Badge>
                          )}
                        </div>
                        {p.description && (
                          <p className="text-[11px] text-muted-foreground truncate">
                            {p.description}
                          </p>
                        )}
                      </div>
                      <Switch
                        checked={p.enabled}
                        onCheckedChange={(v) =>
                          toggle.mutate({ id: p.id, enabled: v })
                        }
                        aria-label={`Toggle ${p.name}`}
                      />
                    </div>

                    {isOpen && (
                      <div className="px-3 pb-3 space-y-2 border-t border-border/40 pt-2">
                        {p.type !== "command" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1 w-full"
                            disabled={!runPluginInActiveWebview}
                            onClick={() => runWidget(p)}
                          >
                            <Play className="h-3 w-3" />
                            Run on current tab
                          </Button>
                        )}
                        {result && (
                          <pre
                            className={cn(
                              "max-h-40 overflow-auto text-[10px] whitespace-pre-wrap break-words rounded border px-2 py-1.5",
                              result.ok
                                ? "border-emerald-500/30 bg-emerald-500/5"
                                : "border-rose-500/30 bg-rose-500/5 text-rose-600 dark:text-rose-300",
                            )}
                          >
                            {result.text}
                          </pre>
                        )}
                        <details className="text-[10px] text-muted-foreground">
                          <summary className="cursor-pointer flex items-center gap-1 hover:text-foreground">
                            <Code2 className="h-3 w-3" />
                            View code
                          </summary>
                          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-muted/30 p-2 font-mono">
                            {p.code}
                          </pre>
                          {p.promptTemplate && (
                            <>
                              <div className="mt-2 font-semibold text-muted-foreground">
                                Prompt template
                              </div>
                              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-border/40 bg-muted/30 p-2">
                                {p.promptTemplate}
                              </pre>
                            </>
                          )}
                        </details>
                        {!p.builtin && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs gap-1 w-full text-rose-600 hover:text-rose-700 hover:bg-rose-500/10"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove plugin "${p.name}"? This cannot be undone.`,
                                )
                              ) {
                                remove.mutate(p.id);
                              }
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                            Remove plugin
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AI Builder sub-view ───────────────────────────────────────────────────

interface AiBuilderProps {
  currentUrl?: string;
  onCancel: () => void;
  onBuilt: (draft: BrowserPlugin) => Promise<void> | void;
  buildPending: boolean;
  savePending: boolean;
  buildAsync: (req: {
    description: string;
    currentUrl?: string;
  }) => Promise<BrowserPlugin>;
}

function AiBuilder({
  currentUrl,
  onCancel,
  onBuilt,
  buildPending,
  savePending,
  buildAsync,
}: AiBuilderProps) {
  const [desc, setDesc] = useState("");
  const [draft, setDraft] = useState<BrowserPlugin | null>(null);

  const runBuild = useCallback(async () => {
    if (!desc.trim()) return;
    try {
      const result = await buildAsync({
        description: desc.trim(),
        currentUrl,
      });
      setDraft(result);
    } catch {
      /* handled by mutation onError */
    }
  }, [desc, currentUrl, buildAsync]);

  return (
    <div className="p-3 space-y-3">
      <div>
        <div className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-violet-500" />
          Describe a plugin
        </div>
        <Textarea
          rows={4}
          placeholder='e.g. "Extract every price on the page and list them in USD"'
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          disabled={buildPending || savePending}
          className="text-sm"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={runBuild}
          disabled={buildPending || savePending || !desc.trim()}
          className="gap-1"
        >
          {buildPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {draft ? "Regenerate" : "Generate"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={buildPending || savePending}
        >
          Cancel
        </Button>
      </div>

      {draft && (
        <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
          <div className="flex items-center gap-2">
            <Badge className="bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30">
              {draft.type}
            </Badge>
            <span className="font-semibold text-sm">{draft.name}</span>
          </div>
          <p className="text-xs text-muted-foreground">{draft.description}</p>
          <Separator className="my-1" />
          <details>
            <summary className="text-[10px] cursor-pointer text-muted-foreground hover:text-foreground">
              View generated code
            </summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] rounded border border-border/40 bg-background/40 p-2 font-mono">
              {draft.code}
            </pre>
          </details>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={async () => {
                await onBuilt(draft);
                setDraft(null);
                setDesc("");
                toast.success(`Installed "${draft.name}"`);
              }}
              disabled={savePending}
              className="gap-1"
            >
              {savePending && <Loader2 className="h-3 w-3 animate-spin" />}
              Install plugin
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(null)}
              disabled={savePending}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Manual creator sub-view ───────────────────────────────────────────────

interface ManualCreatorProps {
  onCancel: () => void;
  onSubmit: (req: {
    name: string;
    description: string;
    type: BrowserPluginType;
    code: string;
    promptTemplate?: string;
    icon?: string;
  }) => Promise<void>;
  saving: boolean;
}

function ManualCreator({ onCancel, onSubmit, saving }: ManualCreatorProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<BrowserPluginType>("page-action");
  const [code, setCode] = useState(
    `(() => ({ title: document.title, h1: document.querySelector('h1')?.innerText || '' }))()`,
  );
  const [tpl, setTpl] = useState("");
  const [icon, setIcon] = useState("");

  return (
    <div className="p-3 space-y-2.5">
      <div className="text-xs font-semibold flex items-center gap-1.5">
        <Plus className="h-3.5 w-3.5" />
        New plugin
      </div>
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Name
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Extract Prices"
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Description
        </label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line summary"
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Type
        </label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as BrowserPluginType)}
          className="w-full h-8 text-sm rounded border border-border/50 bg-background px-2"
        >
          <option value="page-action">page-action (button in AI panel)</option>
          <option value="widget">widget (sidebar card)</option>
          <option value="command">command (prompt-driven)</option>
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Lucide icon (optional)
        </label>
        <Input
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="e.g. Tags, Search, Sparkles"
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Code (single IIFE that returns a JSON-serializable value)
        </label>
        <Textarea
          rows={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="text-xs font-mono"
          spellCheck={false}
        />
      </div>
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Prompt template (optional, uses {`{{result}} {{url}} {{title}}`})
        </label>
        <Textarea
          rows={3}
          value={tpl}
          onChange={(e) => setTpl(e.target.value)}
          className="text-xs"
          placeholder="e.g. Summarize: {{result}}"
        />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          disabled={saving || !name.trim() || !code.trim()}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              description: description.trim(),
              type,
              code,
              promptTemplate: tpl.trim() || undefined,
              icon: icon.trim() || undefined,
            })
          }
          className="gap-1"
        >
          {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          Save plugin
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
