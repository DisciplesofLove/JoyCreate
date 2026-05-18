/**
 * Built-in MCP Tools catalog page.
 *
 * Browseable list of in-process tools the agent runtime can call via
 * `tool.config = { serverName: "builtin", toolName: <id> }`. Provides
 * copy-to-clipboard snippets so users can wire tools into agents
 * manually until the agent editor has a native picker.
 */

import { useMemo, useState } from "react";
import { Boxes, Search, Copy, Check, Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

import { useBuiltinMcpTools } from "@/hooks/useBuiltinMcpTools";

const CATEGORY_COLORS: Record<string, string> = {
  web: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
  knowledge:
    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  system:
    "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  data:
    "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30",
};

export default function McpToolsPage() {
  const { data: tools, isLoading } = useBuiltinMcpTools();
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const list = tools ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        t.id.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q),
    );
  }, [tools, query]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    for (const t of filtered) {
      const arr = m.get(t.category) ?? [];
      arr.push(t);
      m.set(t.category, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  async function handleCopy(id: string) {
    const snippet = JSON.stringify(
      {
        type: "mcp",
        name: id,
        description: `Built-in MCP: ${id}`,
        enabled: true,
        config: { serverName: "builtin", toolName: id },
      },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(snippet);
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Boxes className="h-7 w-7 text-violet-500" />
          Built-in MCP Tools
        </h1>
        <p className="text-muted-foreground mt-1">
          In-process tools agents can call without an external MCP server.
          Copy the JSON snippet into an agent's tool list.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search tools..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading catalog...
        </div>
      ) : grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tools match.</p>
      ) : (
        grouped.map(([category, items]) => (
          <section key={category} className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {category} ({items.length})
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((tool) => {
                const required = new Set(tool.inputSchema.required ?? []);
                const props = Object.entries(tool.inputSchema.properties ?? {});
                return (
                  <Card key={tool.id} className="flex flex-col">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <CardTitle className="text-base truncate">
                            {tool.name}
                          </CardTitle>
                          <CardDescription className="text-xs font-mono mt-0.5">
                            {tool.id}
                          </CardDescription>
                        </div>
                        <Badge
                          variant="outline"
                          className={CATEGORY_COLORS[tool.category]}
                        >
                          {tool.category}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3 flex-1 flex flex-col">
                      <p className="text-sm text-muted-foreground">
                        {tool.description}
                      </p>
                      {props.length > 0 && (
                        <div className="text-xs">
                          <div className="font-medium mb-1">Inputs</div>
                          <ScrollArea className="max-h-32 rounded border bg-muted/40 p-2">
                            <ul className="space-y-1">
                              {props.map(([k, v]) => (
                                <li key={k} className="flex gap-2">
                                  <span className="font-mono">{k}</span>
                                  <span className="text-muted-foreground">
                                    : {v.type}
                                  </span>
                                  {required.has(k) && (
                                    <Badge
                                      variant="outline"
                                      className="ml-auto text-[9px] px-1 py-0"
                                    >
                                      required
                                    </Badge>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </ScrollArea>
                        </div>
                      )}
                      <div className="mt-auto">
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() => handleCopy(tool.id)}
                        >
                          {copiedId === tool.id ? (
                            <>
                              <Check className="h-3.5 w-3.5 mr-1" /> Copied
                            </>
                          ) : (
                            <>
                              <Copy className="h-3.5 w-3.5 mr-1" /> Copy tool JSON
                            </>
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
