/**
 * Featured Tasks page.
 *
 * One-shot autonomous task runner inspired by Hyperagent's "Try a task" tiles.
 * Each card represents a featured template; clicking "Try it now" lets the user
 * tweak a starter brief, runs the agent once, and shows the output inline.
 */

import { useMemo, useState } from "react";
import {
  Sparkles,
  Loader2,
  PlayCircle,
  CheckCircle2,
  AlertCircle,
  Save,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  useFeaturedAgentTemplates,
  useRunFeaturedTask,
  type AgentTemplateSummary,
} from "@/hooks/useAgentTemplates";
import { showError, showSuccess } from "@/lib/toast";

/**
 * Sensible starter briefs so users can run a task with zero typing.
 * Keyed by template id from `initializeDefaultTemplates`.
 */
const DEFAULT_BRIEFS: Record<string, string> = {
  "featured-chief-of-staff":
    "Produce my morning briefing for today. Top 3 inbox items, the next 12 hours of calendar, and a one-paragraph what-matters-today summary.",
  "featured-competitive-radar":
    "Track competitor activity in the AI agent platform space over the last 7 days. Cover Hyperagent, OpenAI Agents, Anthropic Claude, and Replit Agent.",
  "featured-prospect-outreach":
    "Find 5 mid-market SaaS companies (50-500 employees) that recently raised a Series A and draft a personalized cold email for each.",
  "featured-investment-research":
    "Compare the three largest Series A raises in the AI infra space this quarter. Output a ranked tear sheet and a 10-slide pitch outline.",
  "featured-real-estate-kit":
    "Property: 4-bed, 3-bath modern farmhouse, 3,200 sqft, hardwood floors, chef's kitchen, large backyard, top-rated school district. Asking $1.2M.",
  "featured-voice-to-posts":
    "Voice: pragmatic founder, no jargon, learns in public. Themes: building AI agents, distributed systems, indie tooling. Audience: senior engineers and CTOs.",
};

function briefForTemplate(t: AgentTemplateSummary): string {
  return (
    DEFAULT_BRIEFS[t.id] ??
    `Run the ${t.name} workflow with sensible defaults.`
  );
}

function gradientFor(category: string): string {
  switch (category) {
    case "featured":
      return "from-violet-500/15 via-purple-500/10 to-pink-500/15";
    case "research":
      return "from-amber-500/15 via-orange-500/10 to-rose-500/15";
    case "automation":
      return "from-sky-500/15 via-indigo-500/10 to-violet-500/15";
    default:
      return "from-slate-500/15 via-zinc-500/10 to-stone-500/15";
  }
}

function renderOutput(output: any): string {
  if (output == null) return "(no output)";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export default function FeaturedTasksPage() {
  const featured = useFeaturedAgentTemplates();
  const runMutation = useRunFeaturedTask();

  const [search, setSearch] = useState("");
  const [active, setActive] = useState<AgentTemplateSummary | null>(null);
  const [brief, setBrief] = useState("");
  const [keepAgent, setKeepAgent] = useState(false);
  const [result, setResult] = useState<
    | null
    | {
        templateId: string;
        ok: boolean;
        output?: any;
        error?: string;
        agentId?: string;
      }
  >(null);

  const list = featured.data ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q),
    );
  }, [list, search]);

  const openTask = (t: AgentTemplateSummary) => {
    setActive(t);
    setBrief(briefForTemplate(t));
    setKeepAgent(false);
    setResult(null);
  };

  const closeDialog = () => {
    if (runMutation.isPending) return;
    setActive(null);
    setBrief("");
    setResult(null);
  };

  const handleRun = async () => {
    if (!active) return;
    if (!brief.trim()) {
      showError("Please provide a brief for the task");
      return;
    }
    setResult(null);
    try {
      const res = await runMutation.mutateAsync({
        templateId: active.id,
        brief: brief.trim(),
        keepAgent,
      });
      setResult({
        templateId: active.id,
        ok: res.run.success,
        output: res.run.output,
        error: res.run.error,
        agentId: keepAgent ? res.agentId : undefined,
      });
      if (res.run.success) {
        showSuccess(
          keepAgent
            ? "Task complete. Agent saved to My Agents."
            : "Task complete.",
        );
      } else {
        showError(res.run.error || "Task failed");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Task failed";
      setResult({ templateId: active.id, ok: false, error: msg });
      showError(msg);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <PlayCircle className="h-7 w-7 text-violet-500" />
            Featured Tasks
          </h1>
          <p className="text-muted-foreground mt-1">
            One-shot autonomous tasks. Pick a tile, tweak the brief, hit run.
            Output is delivered inline.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="pl-9 w-64"
          />
        </div>
      </div>

      {featured.isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading featured tasks...
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground">
          No featured tasks found.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <Card
              key={t.id}
              className={`bg-gradient-to-br ${gradientFor(t.category)} border-border/50 hover:border-primary/50 transition-all cursor-pointer group`}
              onClick={() => openTask(t)}
            >
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <Sparkles className="h-3 w-3" /> Try it
                  </Badge>
                </div>
                <CardTitle className="mt-3 text-lg">{t.name}</CardTitle>
                <CardDescription className="line-clamp-3 min-h-[3.5rem]">
                  {t.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Badge variant="outline" className="capitalize">
                  {t.category}
                </Badge>
              </CardContent>
              <CardFooter>
                <Button
                  size="sm"
                  className="ml-auto group-hover:translate-x-1 transition-transform"
                >
                  <PlayCircle className="mr-1 h-4 w-4" /> Try it now
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={active !== null} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{active?.name}</DialogTitle>
            <DialogDescription>{active?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="task-brief">Brief</Label>
            <Textarea
              id="task-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={6}
              placeholder="Describe what you want the agent to do..."
              disabled={runMutation.isPending}
            />
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={keepAgent}
                onChange={(e) => setKeepAgent(e.target.checked)}
                disabled={runMutation.isPending}
              />
              <Save className="h-3.5 w-3.5" />
              Save as agent in My Agents after the run
            </label>

            {result && (
              <div className="mt-4 rounded-md border bg-muted/30">
                <div className="flex items-center gap-2 px-3 py-2 border-b">
                  {result.ok ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      <span className="text-sm font-medium">Completed</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-4 w-4 text-rose-500" />
                      <span className="text-sm font-medium">Failed</span>
                    </>
                  )}
                </div>
                <ScrollArea className="max-h-72 p-3">
                  <pre className="whitespace-pre-wrap break-words text-xs font-mono">
                    {result.ok
                      ? renderOutput(result.output)
                      : result.error || "(no error message)"}
                  </pre>
                </ScrollArea>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDialog}
              disabled={runMutation.isPending}
            >
              Close
            </Button>
            <Button
              onClick={handleRun}
              disabled={runMutation.isPending || !brief.trim()}
            >
              {runMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Running...
                </>
              ) : (
                <>
                  <PlayCircle className="h-4 w-4 mr-2" />
                  {result ? "Run again" : "Run task"}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
