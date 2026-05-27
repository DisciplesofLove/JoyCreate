/**
 * JoySearchPage — local-AI-powered web search.
 *
 * Layout:
 *  ┌─────────────────────────────────────────────────────┐
 *  │  [JoySearch logo]  [search input ──────────] [Run]  │
 *  │                    [autocomplete dropdown]          │
 *  │  intent badge · engine toggles · AI rerank          │
 *  ├──────────────────────┬──────────────────────────────┤
 *  │  ▸ Answer card       │  ▸ Suggested follow-ups       │
 *  │    (cited synthesis) │  ▸ Related queries            │
 *  │  ▸ Result cards      │  ▸ Engine breakdown           │
 *  │    (lens row each)   │                              │
 *  └──────────────────────┴──────────────────────────────┘
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  Search,
  Loader2,
  Sparkles,
  Globe,
  Brain,
  ExternalLink,
  FileText,
  ListChecks,
  ShieldCheck,
  Quote,
  Languages,
  Baby,
  Lightbulb,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  useJoySearchAnswer,
  useJoySearchLens,
  useJoySearchQuery,
  useJoySearchSuggest,
} from "@/hooks/useJoySearch";
import type {
  JoySearchEngine,
  JoySearchIntent,
  JoySearchLensMode,
  JoySearchLensResponse,
  JoySearchResult,
} from "@/types/joy_search";
import { joySearchRoute } from "@/routes/joy-search";

const ENGINES: { id: JoySearchEngine; label: string }[] = [
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "brave", label: "Brave" },
];

const INTENT_LABEL: Record<JoySearchIntent, { label: string; tone: string }> = {
  factual: { label: "Factual", tone: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30" },
  navigational: { label: "Navigational", tone: "bg-sky-500/15 text-sky-600 border-sky-500/30" },
  shopping: { label: "Shopping", tone: "bg-amber-500/15 text-amber-600 border-amber-500/30" },
  "how-to": { label: "How-to", tone: "bg-violet-500/15 text-violet-600 border-violet-500/30" },
  news: { label: "News", tone: "bg-rose-500/15 text-rose-600 border-rose-500/30" },
  code: { label: "Code", tone: "bg-cyan-500/15 text-cyan-600 border-cyan-500/30" },
  general: { label: "General", tone: "bg-muted text-muted-foreground border-border" },
};

const LENS_BUTTONS: { id: JoySearchLensMode; label: string; icon: React.ElementType }[] = [
  { id: "summarize", label: "Summarize", icon: FileText },
  { id: "key-points", label: "Key points", icon: ListChecks },
  { id: "fact-check", label: "Fact-check", icon: ShieldCheck },
  { id: "pull-quotes", label: "Pull quotes", icon: Quote },
  { id: "translate", label: "Translate", icon: Languages },
  { id: "eli5", label: "ELI5", icon: Baby },
  { id: "explain", label: "Explain", icon: Lightbulb },
];

export default function JoySearchPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: joySearchRoute.id });
  const initialQ = (search as { q?: string }).q ?? "";

  const [inputValue, setInputValue] = useState(initialQ);
  const [activeQuery, setActiveQuery] = useState(initialQ);
  const [showSuggest, setShowSuggest] = useState(false);
  const [engines, setEngines] = useState<JoySearchEngine[]>(["duckduckgo", "brave"]);
  const [aiRerank, setAiRerank] = useState(false);
  const [safe, setSafe] = useState<"off" | "moderate" | "strict">("moderate");

  const suggestions = useJoySearchSuggest(inputValue);
  const queryResult = useJoySearchQuery(activeQuery, {
    engines,
    aiRerank,
    safe,
    enabled: !!activeQuery,
  });
  const answerResult = useJoySearchAnswer(activeQuery, { enabled: !!activeQuery });

  const runSearch = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setActiveQuery(trimmed);
      setShowSuggest(false);
      navigate({ to: "/joy-search", search: { q: trimmed } });
    },
    [navigate],
  );

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      runSearch(inputValue);
    },
    [inputValue, runSearch],
  );

  const toggleEngine = useCallback((id: JoySearchEngine) => {
    setEngines((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id],
    );
  }, []);

  const intent = queryResult.data?.intent ?? "general";
  const intentMeta = INTENT_LABEL[intent];

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Header */}
      <header className="sticky top-0 z-20 px-6 py-4 border-b border-border/50 bg-background/95 backdrop-blur">
        <div className="flex items-center gap-3 max-w-6xl mx-auto">
          <div className="flex items-center gap-2 shrink-0">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-500 to-sky-500 flex items-center justify-center">
              <Search className="h-4 w-4 text-white" />
            </div>
            <span className="font-bold text-lg tracking-tight">JoySearch</span>
            <Badge variant="outline" className="text-[10px] border-violet-500/40 text-violet-500">
              local AI
            </Badge>
          </div>

          <form onSubmit={onSubmit} className="flex-1 relative">
            <Input
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setShowSuggest(true);
              }}
              onFocus={() => setShowSuggest(true)}
              onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
              placeholder="Ask anything — JoySearch synthesises a grounded answer from the web"
              className="h-10 pr-10 text-sm"
              autoFocus
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-8 w-8"
              disabled={!inputValue.trim()}
              title="Search"
            >
              {queryResult.isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Search className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>

            {showSuggest && suggestions.length > 0 && (
              <div className="absolute top-11 left-0 right-0 z-30 bg-popover border border-border rounded-md shadow-lg overflow-hidden">
                {suggestions.slice(0, 8).map((s) => (
                  <button
                    type="button"
                    key={s}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setInputValue(s);
                      runSearch(s);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted/60 flex items-center gap-2"
                  >
                    <Search className="h-3 w-3 text-muted-foreground" />
                    {s}
                  </button>
                ))}
              </div>
            )}
          </form>
        </div>

        {/* Filter row */}
        <div className="mt-2 flex items-center gap-3 max-w-6xl mx-auto text-xs text-muted-foreground">
          {activeQuery && (
            <Badge variant="outline" className={cn("text-[10px]", intentMeta.tone)}>
              {intentMeta.label}
            </Badge>
          )}
          <div className="flex items-center gap-1.5">
            <Globe className="h-3 w-3" />
            <span>Engines:</span>
            {ENGINES.map((e) => (
              <button
                type="button"
                key={e.id}
                onClick={() => toggleEngine(e.id)}
                className={cn(
                  "px-1.5 py-0.5 rounded border text-[10px] transition-colors",
                  engines.includes(e.id)
                    ? "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300"
                    : "border-border text-muted-foreground hover:bg-muted/40",
                )}
              >
                {e.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <Brain className="h-3 w-3" />
            <span>AI rerank</span>
            <Switch checked={aiRerank} onCheckedChange={setAiRerank} className="scale-75" />
          </div>
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3" />
            <Select value={safe} onValueChange={(v) => setSafe(v as typeof safe)}>
              <SelectTrigger className="h-6 text-[10px] w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Safe: off</SelectItem>
                <SelectItem value="moderate">Safe: moderate</SelectItem>
                <SelectItem value="strict">Safe: strict</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {queryResult.data && (
            <span className="ml-auto">
              {queryResult.data.results.length} results · {queryResult.data.tookMs}ms
              {queryResult.data.cached && " · cached"}
            </span>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
          <main className="space-y-4 min-w-0">
            {!activeQuery && <EmptyHero onPick={(q) => { setInputValue(q); runSearch(q); }} />}

            {activeQuery && (
              <AnswerCard
                query={activeQuery}
                state={answerResult}
                onCitationClick={(url) => window.open(url, "_blank")}
                onFollowUp={(q) => { setInputValue(q); runSearch(q); }}
              />
            )}

            {queryResult.isError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-500 mt-0.5" />
                <div>
                  <div className="font-medium text-rose-600 dark:text-rose-300">Search failed</div>
                  <div className="text-muted-foreground mt-0.5">
                    {(queryResult.error as Error)?.message ?? "Unknown error"}
                  </div>
                </div>
              </div>
            )}

            {queryResult.isLoading && <ResultsSkeleton />}

            {queryResult.data && queryResult.data.results.length === 0 && (
              <div className="rounded-lg border border-border/50 bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                No results found. Try different keywords or toggle additional engines.
              </div>
            )}

            {queryResult.data?.results.map((r) => (
              <ResultCard key={r.url} result={r} />
            ))}
          </main>

          {/* Right rail */}
          <aside className="space-y-4">
            {queryResult.data?.suggestions && queryResult.data.suggestions.length > 0 && (
              <div className="rounded-lg border border-border/50 bg-card/40 p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                  Related searches
                </div>
                <ul className="space-y-1">
                  {queryResult.data.suggestions.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => { setInputValue(s); runSearch(s); }}
                        className="text-xs text-sky-600 dark:text-sky-300 hover:underline text-left"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-lg border border-border/50 bg-card/40 p-3 text-xs text-muted-foreground">
              <div className="text-[10px] uppercase tracking-wide mb-1">Why JoySearch</div>
              <ul className="space-y-1 list-disc list-inside">
                <li>Multi-engine fusion (reciprocal rank)</li>
                <li>Domain reputation reranking</li>
                <li>Local AI answer synthesis</li>
                <li>7 on-demand AI lenses per result</li>
                <li>Zero tracking, no API keys</li>
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ── Empty hero ─────────────────────────────────────────────────────────────

const SAMPLE_QUERIES = [
  "What is the Electron framework",
  "How does reciprocal rank fusion work",
  "Latest news on local LLMs",
  "Compare Jotai vs Zustand for state management",
];

function EmptyHero({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="py-16 text-center space-y-4">
      <Sparkles className="h-12 w-12 text-violet-500 mx-auto" />
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          Search the web with local AI.
        </h1>
        <p className="text-sm text-muted-foreground max-w-md mx-auto mt-2">
          Type a question — JoySearch fuses results from multiple engines and
          synthesises a grounded answer with inline citations using your
          on-device model.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 justify-center max-w-xl mx-auto">
        {SAMPLE_QUERIES.map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => onPick(s)}
            className="text-xs px-3 py-1.5 rounded-full border border-border bg-muted/30 hover:bg-muted/60 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Answer card (Perplexity-style) ─────────────────────────────────────────

function AnswerCard({
  query,
  state,
  onCitationClick,
  onFollowUp,
}: {
  query: string;
  state: ReturnType<typeof useJoySearchAnswer>;
  onCitationClick: (url: string) => void;
  onFollowUp: (q: string) => void;
}) {
  if (state.isLoading) {
    return (
      <div className="rounded-xl border border-violet-500/40 bg-gradient-to-br from-violet-500/5 to-sky-500/5 p-4 space-y-2">
        <div className="flex items-center gap-2 text-xs text-violet-600 dark:text-violet-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Synthesising grounded answer from top sources…</span>
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[88%]" />
        <Skeleton className="h-4 w-[72%]" />
      </div>
    );
  }
  if (state.isError) return null;
  if (!state.data) return null;

  // Replace [n] tokens with clickable citation chips.
  const citationMap = new Map(state.data.citations.map((c) => [c.index, c]));
  const parts = state.data.answer.split(/(\[\d+\])/g);

  return (
    <div className="rounded-xl border border-violet-500/40 bg-gradient-to-br from-violet-500/5 to-sky-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-500" />
        <span className="font-semibold text-sm">Answer</span>
        <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-500">
          {state.data.model}
        </Badge>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {state.data.tookMs}ms
        </span>
      </div>

      <div className="text-sm leading-relaxed whitespace-pre-wrap">
        {parts.map((p, i) => {
          const m = p.match(/^\[(\d+)\]$/);
          if (m) {
            const idx = Number(m[1]);
            const cite = citationMap.get(idx);
            if (cite) {
              return (
                <button
                  type="button"
                  key={i}
                  onClick={() => onCitationClick(cite.url)}
                  title={cite.title}
                  className="inline-flex items-center justify-center h-4 min-w-[16px] mx-0.5 px-1 rounded text-[10px] bg-violet-500/20 hover:bg-violet-500/40 text-violet-700 dark:text-violet-200 border border-violet-500/30 align-baseline"
                >
                  {idx}
                </button>
              );
            }
          }
          return <span key={i}>{p}</span>;
        })}
      </div>

      {state.data.citations.length > 0 && (
        <div className="pt-2 border-t border-violet-500/20">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            Sources
          </div>
          <div className="flex flex-wrap gap-1.5">
            {state.data.citations.map((c) => (
              <button
                type="button"
                key={c.index}
                onClick={() => onCitationClick(c.url)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] border border-border bg-background hover:bg-muted/60 max-w-[280px]"
                title={c.url}
              >
                <span className="text-violet-600 dark:text-violet-300 font-medium">
                  [{c.index}]
                </span>
                <span className="truncate">{c.displayUrl}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {state.data.followUps.length > 0 && (
        <div className="pt-2 border-t border-violet-500/20">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            Suggested follow-ups
          </div>
          <div className="flex flex-wrap gap-1.5">
            {state.data.followUps.map((q) => (
              <button
                type="button"
                key={q}
                onClick={() => onFollowUp(q)}
                className="text-xs px-2 py-1 rounded-full border border-sky-500/30 bg-sky-500/5 hover:bg-sky-500/15 text-sky-600 dark:text-sky-300"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Result card with inline lens row ──────────────────────────────────────

function ResultCard({ result }: { result: JoySearchResult }) {
  const [activeLens, setActiveLens] = useState<JoySearchLensMode | null>(null);
  const [translateLang, setTranslateLang] = useState("Spanish");
  const lensMutation = useJoySearchLens();
  const [lensResult, setLensResult] = useState<JoySearchLensResponse | null>(null);
  const [lensError, setLensError] = useState<string | null>(null);

  const runLens = useCallback(
    async (mode: JoySearchLensMode) => {
      setActiveLens(mode);
      setLensResult(null);
      setLensError(null);
      try {
        const res = await lensMutation.mutateAsync({
          url: result.url,
          mode,
          targetLang: mode === "translate" ? translateLang : undefined,
        });
        setLensResult(res);
      } catch (err) {
        setLensError((err as Error).message);
      }
    },
    [result.url, translateLang, lensMutation],
  );

  return (
    <article className="rounded-lg border border-border/50 bg-card/40 hover:bg-card/70 transition-colors p-3 space-y-2">
      <div className="flex items-start gap-2">
        {result.faviconUrl && (
          <img
            src={result.faviconUrl}
            alt=""
            width={16}
            height={16}
            className="mt-1 rounded-sm shrink-0"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        )}
        <div className="flex-1 min-w-0">
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-sky-600 dark:text-sky-300 hover:underline line-clamp-2"
          >
            {result.title}
          </a>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
            <span className="truncate">{result.displayUrl}</span>
            {result.sources.length > 1 && (
              <Badge variant="outline" className="text-[9px] px-1 py-0">
                {result.sources.join(" + ")}
              </Badge>
            )}
            {result.reputation && result.reputation > 1.2 && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 border-emerald-500/40 text-emerald-600">
                trusted
              </Badge>
            )}
          </div>
        </div>
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground shrink-0"
          title="Open"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {result.snippet && (
        <p className="text-xs text-muted-foreground line-clamp-3">{result.snippet}</p>
      )}

      {/* Lens row */}
      <div className="flex flex-wrap gap-1 pt-1">
        {LENS_BUTTONS.map((b) => (
          <button
            type="button"
            key={b.id}
            onClick={() => runLens(b.id)}
            disabled={lensMutation.isPending && activeLens === b.id}
            className={cn(
              "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors",
              activeLens === b.id
                ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300"
                : "border-border bg-background hover:bg-muted/60 text-muted-foreground",
            )}
          >
            {lensMutation.isPending && activeLens === b.id ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <b.icon className="h-2.5 w-2.5" />
            )}
            {b.label}
          </button>
        ))}
        {activeLens === "translate" && (
          <input
            value={translateLang}
            onChange={(e) => setTranslateLang(e.target.value)}
            placeholder="lang"
            className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-background h-5 w-20"
          />
        )}
      </div>

      {activeLens && (lensMutation.isPending || lensResult || lensError) && (
        <LensResultPanel
          mode={activeLens}
          loading={lensMutation.isPending}
          result={lensResult}
          error={lensError}
        />
      )}
    </article>
  );
}

// ── Lens result panel ──────────────────────────────────────────────────────

function LensResultPanel({
  mode,
  loading,
  result,
  error,
}: {
  mode: JoySearchLensMode;
  loading: boolean;
  result: JoySearchLensResponse | null;
  error: string | null;
}) {
  const [expanded, setExpanded] = useState(true);

  if (loading) {
    return (
      <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-2 text-xs flex items-center gap-2 text-violet-600 dark:text-violet-300">
        <Loader2 className="h-3 w-3 animate-spin" />
        Running {mode}…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-600 dark:text-rose-300">
        {error}
      </div>
    );
  }
  if (!result) return null;

  return (
    <div className="rounded-md border border-violet-500/30 bg-violet-500/5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2 py-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-violet-700 dark:text-violet-200"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {mode} · {result.model} · {result.tookMs}ms
      </button>
      {expanded && (
        <div className="px-3 pb-2 pt-1 text-xs space-y-1">
          {result.text && <div className="whitespace-pre-wrap">{result.text}</div>}
          {result.keyPoints && (
            <ul className="space-y-1">
              {result.keyPoints.map((p, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[9px] px-1 py-0 shrink-0 mt-0.5",
                      p.importance === "high" && "border-rose-500/40 text-rose-500",
                      p.importance === "medium" && "border-amber-500/40 text-amber-500",
                      p.importance === "low" && "border-muted text-muted-foreground",
                    )}
                  >
                    {p.importance}
                  </Badge>
                  <span>{p.point}</span>
                </li>
              ))}
            </ul>
          )}
          {result.claims && (
            <ul className="space-y-1.5">
              {result.claims.map((c, i) => (
                <li key={i} className="border-l-2 border-violet-500/30 pl-2">
                  <div className="font-medium">{c.claim}</div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[9px] px-1 py-0",
                        c.verdict === "supported" && "border-emerald-500/40 text-emerald-600",
                        c.verdict === "false" && "border-rose-500/40 text-rose-600",
                        c.verdict === "unsupported" && "border-amber-500/40 text-amber-600",
                        c.verdict === "needs-verification" && "border-sky-500/40 text-sky-600",
                      )}
                    >
                      {c.verdict}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      conf {(c.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{c.reasoning}</div>
                </li>
              ))}
            </ul>
          )}
          {result.quotes && (
            <ul className="space-y-1.5">
              {result.quotes.map((q, i) => (
                <li key={i} className="border-l-2 border-violet-500/30 pl-2 italic">
                  “{q.quote}”
                  {q.context && (
                    <div className="text-[10px] text-muted-foreground not-italic mt-0.5">
                      {q.context}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────

function ResultsSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-lg border border-border/50 bg-card/40 p-3 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-[88%]" />
        </div>
      ))}
    </div>
  );
}
