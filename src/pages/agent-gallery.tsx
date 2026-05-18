/**
 * Featured Agent Gallery
 *
 * Curated, one-click agent templates inspired by Hyperagent's "Browse agents"
 * surface. Each tile lets the user spin up a new agent from a template with a
 * single click.
 */

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bot,
  Sparkles,
  ArrowRight,
  Loader2,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

import {
  useFeaturedAgentTemplates,
  useAgentTemplates,
  useCreateAgentFromTemplate,
  type AgentTemplateSummary,
} from "@/hooks/useAgentTemplates";
import { showError, showSuccess } from "@/lib/toast";

const CATEGORY_GRADIENTS: Record<string, string> = {
  featured: "from-violet-500/15 via-purple-500/10 to-pink-500/15",
  data: "from-blue-500/15 via-cyan-500/10 to-teal-500/15",
  development: "from-emerald-500/15 via-green-500/10 to-lime-500/15",
  research: "from-amber-500/15 via-orange-500/10 to-rose-500/15",
  automation: "from-sky-500/15 via-indigo-500/10 to-violet-500/15",
  coordination: "from-rose-500/15 via-pink-500/10 to-fuchsia-500/15",
};

function gradientFor(category: string): string {
  return (
    CATEGORY_GRADIENTS[category] ??
    "from-slate-500/15 via-zinc-500/10 to-stone-500/15"
  );
}

export default function AgentGalleryPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AgentTemplateSummary | null>(null);
  const [name, setName] = useState("");

  const featured = useFeaturedAgentTemplates();
  const all = useAgentTemplates();
  const createMutation = useCreateAgentFromTemplate();

  const featuredList = featured.data ?? [];
  const allList = (all.data ?? []).filter(
    (t) => t.featured !== true, // already shown in the featured row
  );

  const filter = (list: AgentTemplateSummary[]) => {
    if (!search.trim()) return list;
    const q = search.toLowerCase();
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q),
    );
  };

  const handleUseTemplate = (template: AgentTemplateSummary) => {
    setSelected(template);
    setName(template.name);
  };

  const handleConfirmCreate = async () => {
    if (!selected) return;
    if (!name.trim()) {
      showError("Please enter a name for the agent");
      return;
    }
    try {
      const agent = await createMutation.mutateAsync({
        templateId: selected.id,
        name: name.trim(),
      });
      showSuccess(`Created agent: ${agent.name}`);
      setSelected(null);
      setName("");
      navigate({ to: `/agents/${agent.id}` });
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "Failed to create agent",
      );
    }
  };

  const renderTile = (template: AgentTemplateSummary) => (
    <Card
      key={template.id}
      className={`bg-gradient-to-br ${gradientFor(
        template.category,
      )} border-border/50 hover:border-primary/50 transition-all cursor-pointer group`}
      onClick={() => handleUseTemplate(template)}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="rounded-lg bg-background/80 p-2">
            <Bot className="h-5 w-5 text-violet-500" />
          </div>
          {template.featured && (
            <Badge variant="secondary" className="gap-1">
              <Sparkles className="h-3 w-3" /> Featured
            </Badge>
          )}
        </div>
        <CardTitle className="mt-3 text-lg">{template.name}</CardTitle>
        <CardDescription className="line-clamp-3 min-h-[3.5rem]">
          {template.description}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Badge variant="outline" className="capitalize">
          {template.category}
        </Badge>
      </CardContent>
      <CardFooter>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto group-hover:translate-x-1 transition-transform"
        >
          Use template <ArrowRight className="ml-1 h-4 w-4" />
        </Button>
      </CardFooter>
    </Card>
  );

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Gallery</h1>
          <p className="text-muted-foreground mt-1">
            One-click agents for the work you do every day. Pick a template
            and customize from there.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates..."
              className="pl-9 w-64"
            />
          </div>
          <Button variant="outline" onClick={() => navigate({ to: "/agents" })}>
            My Agents
          </Button>
        </div>
      </div>

      {/* Featured */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="h-5 w-5 text-violet-500" />
          <h2 className="text-xl font-semibold">Featured</h2>
        </div>
        {featured.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading featured
            templates...
          </div>
        ) : featuredList.length === 0 ? (
          <p className="text-muted-foreground">
            No featured templates available yet.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filter(featuredList).map(renderTile)}
          </div>
        )}
      </section>

      {/* All templates */}
      <section>
        <h2 className="text-xl font-semibold mb-4">All templates</h2>
        {all.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading templates...
          </div>
        ) : allList.length === 0 ? (
          <p className="text-muted-foreground">No templates available.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filter(allList).map(renderTile)}
          </div>
        )}
      </section>

      {/* Create-from-template dialog */}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create agent from template</DialogTitle>
            <DialogDescription>
              {selected?.description ??
                "Give your new agent a name. You can customize everything else after."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="agent-name">Agent name</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. My Morning Briefing"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSelected(null);
                setName("");
              }}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmCreate}
              disabled={createMutation.isPending || !name.trim()}
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              Create agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
