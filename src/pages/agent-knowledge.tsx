/**
 * Agent Knowledge Base page.
 *
 * Pick an agent → manage its document collection (add text or URL),
 * search across it, and remove documents. Documents persist across runs
 * and are available to the agent at runtime through
 * `searchAgentKnowledgeInternal` in the main process.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Book,
  Globe,
  Loader2,
  Plus,
  Search,
  Trash2,
  FileText,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  useAgentKbDocs,
  useAddAgentKbText,
  useAddAgentKbUrl,
  useDeleteAgentKbDoc,
  useClearAgentKb,
  useSearchAgentKb,
  type KbSearchResult,
} from "@/hooks/useAgentKnowledge";
import { agentBuilderClient } from "@/ipc/agent_builder_client";
import { showError, showSuccess } from "@/lib/toast";

export default function AgentKnowledgePage() {
  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => agentBuilderClient.listAgents(),
  });

  const [agentId, setAgentId] = useState<string>("");
  const [addOpen, setAddOpen] = useState(false);
  const [tab, setTab] = useState<"text" | "url">("text");
  const [textForm, setTextForm] = useState({
    title: "",
    content: "",
    source: "",
  });
  const [urlForm, setUrlForm] = useState({ url: "", title: "" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KbSearchResult[]>([]);

  const docsQuery = useAgentKbDocs(agentId || null);
  const addTextMutation = useAddAgentKbText();
  const addUrlMutation = useAddAgentKbUrl();
  const deleteMutation = useDeleteAgentKbDoc();
  const clearMutation = useClearAgentKb();
  const searchMutation = useSearchAgentKb();

  const agents = agentsQuery.data ?? [];
  const docs = docsQuery.data ?? [];
  const selectedAgent = useMemo(
    () => agents.find((a) => a.id === agentId),
    [agents, agentId],
  );

  const resetAdd = () => {
    setAddOpen(false);
    setTextForm({ title: "", content: "", source: "" });
    setUrlForm({ url: "", title: "" });
    setTab("text");
  };

  const handleAddText = async () => {
    if (!agentId) {
      showError("Pick an agent first");
      return;
    }
    try {
      await addTextMutation.mutateAsync({
        agentId,
        title: textForm.title,
        content: textForm.content,
        source: textForm.source.trim() || undefined,
      });
      showSuccess("Added to knowledge base");
      resetAdd();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to add");
    }
  };

  const handleAddUrl = async () => {
    if (!agentId) {
      showError("Pick an agent first");
      return;
    }
    try {
      await addUrlMutation.mutateAsync({
        agentId,
        url: urlForm.url,
        title: urlForm.title.trim() || undefined,
      });
      showSuccess("URL fetched and indexed");
      resetAdd();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to fetch URL");
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!agentId) return;
    if (!window.confirm("Delete this document from the knowledge base?")) return;
    try {
      await deleteMutation.mutateAsync({ agentId, documentId });
      showSuccess("Document deleted");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const handleClear = async () => {
    if (!agentId) return;
    if (
      !window.confirm(
        "Delete ALL documents in this agent's knowledge base? This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      await clearMutation.mutateAsync(agentId);
      showSuccess("Knowledge base cleared");
      setSearchResults([]);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to clear");
    }
  };

  const handleSearch = async () => {
    if (!agentId) {
      showError("Pick an agent first");
      return;
    }
    if (!searchQuery.trim()) return;
    try {
      const results = await searchMutation.mutateAsync({
        agentId,
        query: searchQuery.trim(),
        topK: 8,
      });
      setSearchResults(results);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Search failed");
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Book className="h-7 w-7 text-emerald-500" />
            Agent Knowledge
          </h1>
          <p className="text-muted-foreground mt-1">
            Give each agent its own searchable library of text and web pages.
            Agents can retrieve passages at runtime.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent</CardTitle>
          <CardDescription>
            Pick which agent's knowledge base you want to manage.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col md:flex-row gap-3 md:items-center">
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className="md:w-80">
              <SelectValue placeholder="Pick an agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.length === 0 ? (
                <SelectItem value="" disabled>
                  No agents yet
                </SelectItem>
              ) : (
                agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          {agentId && (
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4 mr-2" /> Add document
              </Button>
              <Button
                variant="ghost"
                className="text-rose-500 hover:text-rose-600"
                onClick={handleClear}
                disabled={clearMutation.isPending || docs.length === 0}
              >
                <Trash2 className="h-4 w-4 mr-2" /> Clear all
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {agentId && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Search className="h-4 w-4" /> Search
              </CardTitle>
              <CardDescription>
                Preview what the agent would retrieve for a query.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Ask anything in the agent's library..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                />
                <Button onClick={handleSearch} disabled={searchMutation.isPending}>
                  {searchMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {searchResults.length > 0 && (
                <ScrollArea className="max-h-72">
                  <div className="space-y-2">
                    {searchResults.map((r, i) => (
                      <div
                        key={r.id}
                        className="rounded-md border border-border/50 p-3 text-sm"
                      >
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                          <Sparkles className="h-3 w-3 text-emerald-500" />
                          <span>
                            #{i + 1} · score {r.score.toFixed(3)}
                          </span>
                          {r.title && (
                            <Badge variant="outline" className="ml-auto">
                              {r.title}
                            </Badge>
                          )}
                        </div>
                        <p className="line-clamp-4">{r.content}</p>
                        {r.source && (
                          <p className="text-xs text-muted-foreground mt-1 truncate">
                            {r.source}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          <section>
            <h2 className="text-lg font-semibold mb-3">
              Documents
              {selectedAgent && (
                <span className="text-muted-foreground font-normal text-sm ml-2">
                  · {selectedAgent.name}
                </span>
              )}
            </h2>
            {docsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading...
              </div>
            ) : docs.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center text-muted-foreground">
                  <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  No documents yet. Click "Add document" to seed this agent's
                  knowledge.
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {docs.map((d) => (
                  <Card key={d.id} className="border-border/50">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        {d.source ? (
                          <Globe className="h-3.5 w-3.5 text-sky-500" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 text-emerald-500" />
                        )}
                        <span className="truncate">{d.title || "(untitled)"}</span>
                      </CardTitle>
                      {d.source && (
                        <CardDescription className="truncate text-xs">
                          {d.source}
                        </CardDescription>
                      )}
                    </CardHeader>
                    <CardContent className="text-xs text-muted-foreground space-y-2">
                      <p className="line-clamp-3">{d.content}</p>
                      <div className="flex items-center gap-2 text-[10px]">
                        <Badge variant="outline">
                          {d.chunkCount ?? "?"} chunks
                        </Badge>
                        <span>{new Date(d.createdAt).toLocaleDateString()}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 px-2 text-rose-500 hover:text-rose-600"
                          onClick={() => handleDelete(d.id)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <Dialog open={addOpen} onOpenChange={(o) => !o && resetAdd()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Add to knowledge base</DialogTitle>
            <DialogDescription>
              Paste text directly or supply a URL to fetch and index.
            </DialogDescription>
          </DialogHeader>
          <Tabs value={tab} onValueChange={(v) => setTab(v as "text" | "url")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="text">Text</TabsTrigger>
              <TabsTrigger value="url">URL</TabsTrigger>
            </TabsList>
            <TabsContent value="text" className="space-y-3 py-2">
              <div className="grid gap-2">
                <Label htmlFor="kb-title">Title</Label>
                <Input
                  id="kb-title"
                  value={textForm.title}
                  onChange={(e) =>
                    setTextForm({ ...textForm, title: e.target.value })
                  }
                  placeholder="e.g. Brand voice guide"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="kb-content">Content</Label>
                <Textarea
                  id="kb-content"
                  rows={8}
                  value={textForm.content}
                  onChange={(e) =>
                    setTextForm({ ...textForm, content: e.target.value })
                  }
                  placeholder="Paste the document body here..."
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="kb-source">Source (optional)</Label>
                <Input
                  id="kb-source"
                  value={textForm.source}
                  onChange={(e) =>
                    setTextForm({ ...textForm, source: e.target.value })
                  }
                  placeholder="e.g. notion://page/123 or freeform"
                />
              </div>
            </TabsContent>
            <TabsContent value="url" className="space-y-3 py-2">
              <div className="grid gap-2">
                <Label htmlFor="kb-url">URL</Label>
                <Input
                  id="kb-url"
                  value={urlForm.url}
                  onChange={(e) =>
                    setUrlForm({ ...urlForm, url: e.target.value })
                  }
                  placeholder="https://example.com/article"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="kb-url-title">Title override (optional)</Label>
                <Input
                  id="kb-url-title"
                  value={urlForm.title}
                  onChange={(e) =>
                    setUrlForm({ ...urlForm, title: e.target.value })
                  }
                  placeholder="Defaults to the page's <title>"
                />
              </div>
            </TabsContent>
          </Tabs>
          <DialogFooter>
            <Button variant="outline" onClick={resetAdd}>
              Cancel
            </Button>
            {tab === "text" ? (
              <Button
                onClick={handleAddText}
                disabled={addTextMutation.isPending}
              >
                {addTextMutation.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                )}
                Add
              </Button>
            ) : (
              <Button
                onClick={handleAddUrl}
                disabled={addUrlMutation.isPending}
              >
                {addUrlMutation.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                )}
                Fetch & index
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
