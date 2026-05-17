/**
 * API Gateway — manage endpoints, keys, and view usage for agents exposed
 * over HTTP. Uses hooks from `useApiGateway.ts`.
 */

import React, { useMemo, useState } from "react";
import {
  useApiEndpoint,
  useApiEndpoints,
  useApiGatewayStatus,
  useApiKeys,
  useApiUsage,
  useCreateApiEndpoint,
  useCreateApiKey,
  useDeleteApiEndpoint,
  useRevokeApiKey,
  useStartApiGateway,
  useStopApiGateway,
  useUpdateApiEndpoint,
} from "@/hooks/useApiGateway";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

function formatWei(wei: string): string {
  try {
    const n = BigInt(wei);
    if (n === 0n) return "free";
    if (n < 1_000_000_000n) return `${n} wei`;
    // gwei
    if (n < 1_000_000_000_000_000n) return `${Number(n) / 1e9} gwei`;
    return `${Number(n) / 1e18} ETH`;
  } catch {
    return wei;
  }
}

export default function ApiGatewayPage() {
  const status = useApiGatewayStatus();
  const start = useStartApiGateway();
  const stop = useStopApiGateway();
  const endpoints = useApiEndpoints();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  React.useEffect(() => {
    if (!selectedId && endpoints.data && endpoints.data.length > 0) {
      setSelectedId(endpoints.data[0].id);
    }
  }, [endpoints.data, selectedId]);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">API Gateway</h1>
          <p className="text-muted-foreground">
            Expose any local agent as an authenticated, metered HTTP
            endpoint. Each call is rate-limited per key and billed per
            request + per 1k output tokens.
          </p>
        </header>

        {/* Server status */}
        <Card>
          <CardHeader>
            <CardTitle>Server</CardTitle>
            <CardDescription>
              Local HTTP server (loopback only). Default port 18791.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              {status.data?.running ? (
                <Badge variant="default">running</Badge>
              ) : (
                <Badge variant="outline">stopped</Badge>
              )}
              {status.data?.baseUrl && (
                <code className="text-sm">{status.data.baseUrl}</code>
              )}
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={status.data?.running || start.isPending}
                  onClick={() => start.mutate(undefined)}
                >
                  Start
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!status.data?.running || stop.isPending}
                  onClick={() => stop.mutate()}
                >
                  Stop
                </Button>
              </div>
            </div>
            {status.data?.baseUrl && (
              <div className="text-xs text-muted-foreground font-mono">
                {`POST ${status.data.baseUrl}/api/v1/<slug>`}
                {` -H "x-api-key: <secret>"`}
                {` -H "content-type: application/json" -d '{"input":"hello"}'`}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-1 space-y-3">
            <CreateEndpointForm onCreated={(id) => setSelectedId(id)} />
            <EndpointList
              endpoints={endpoints.data ?? []}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
          <div className="col-span-2">
            {selectedId ? (
              <EndpointDetail
                id={selectedId}
                onDeleted={() => setSelectedId(null)}
              />
            ) : (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">
                  Select or create an endpoint to manage keys and view usage.
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create endpoint
// ---------------------------------------------------------------------------

function CreateEndpointForm(props: { onCreated: (id: number) => void }) {
  const create = useCreateApiEndpoint();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const onSubmit = () => {
    if (!slug.trim() || !name.trim()) return;
    create.mutate(
      { slug: slug.trim(), name: name.trim() },
      {
        onSuccess: (row) => {
          props.onCreated(row.id);
          setSlug("");
          setName("");
        },
      },
    );
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New endpoint</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div>
          <Label className="text-xs">Slug (URL segment)</Label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="my-agent"
          />
        </div>
        <div>
          <Label className="text-xs">Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Agent v1"
          />
        </div>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={create.isPending || !slug.trim() || !name.trim()}
          className="w-full"
        >
          {create.isPending ? "Creating…" : "Create"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Endpoint list
// ---------------------------------------------------------------------------

function EndpointList(props: {
  endpoints: { id: number; slug: string; name: string; enabled: boolean }[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  if (props.endpoints.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          No endpoints yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Endpoints</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {props.endpoints.map((e) => (
          <button
            key={e.id}
            onClick={() => props.onSelect(e.id)}
            className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-muted ${
              props.selectedId === e.id ? "bg-muted font-medium" : ""
            }`}
          >
            <div>{e.name}</div>
            <div className="text-xs text-muted-foreground font-mono">
              /api/v1/{e.slug} {!e.enabled && "(disabled)"}
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Endpoint detail (settings / keys / usage)
// ---------------------------------------------------------------------------

function EndpointDetail(props: { id: number; onDeleted: () => void }) {
  const detail = useApiEndpoint(props.id);
  const update = useUpdateApiEndpoint();
  const del = useDeleteApiEndpoint();

  if (detail.isLoading) return <div>Loading…</div>;
  if (detail.isError)
    return <div className="text-destructive">{detail.error.message}</div>;
  const ep = detail.data;
  if (!ep) return null;

  return (
    <Tabs defaultValue="settings">
      <TabsList>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="keys">
          Keys ({ep.activeKeyCount})
        </TabsTrigger>
        <TabsTrigger value="usage">Usage</TabsTrigger>
      </TabsList>
      <TabsContent value="settings" className="pt-4">
        <SettingsTab
          endpoint={ep}
          onUpdate={(args) => update.mutate({ id: ep.id, ...args })}
          onDelete={() =>
            del.mutate(ep.id, { onSuccess: props.onDeleted })
          }
          isUpdating={update.isPending}
          isDeleting={del.isPending}
        />
      </TabsContent>
      <TabsContent value="keys" className="pt-4">
        <KeysTab endpointId={ep.id} />
      </TabsContent>
      <TabsContent value="usage" className="pt-4">
        <UsageTab endpointId={ep.id} />
      </TabsContent>
    </Tabs>
  );
}

function SettingsTab(props: {
  endpoint: ReturnType<typeof useApiEndpoint>["data"] & object;
  onUpdate: (args: {
    name?: string;
    enabled?: boolean;
    pricePerCallWei?: string;
    pricePerKTokenWei?: string;
    rateLimitPerMin?: number;
  }) => void;
  onDelete: () => void;
  isUpdating: boolean;
  isDeleting: boolean;
}) {
  const { endpoint, onUpdate, onDelete } = props;
  const [name, setName] = useState(endpoint.name);
  const [pricePerCall, setPricePerCall] = useState(endpoint.pricePerCallWei);
  const [pricePerK, setPricePerK] = useState(endpoint.pricePerKTokenWei);
  const [rateLimit, setRateLimit] = useState(String(endpoint.rateLimitPerMin));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {endpoint.slug}{" "}
          {endpoint.enabled ? (
            <Badge variant="default">enabled</Badge>
          ) : (
            <Badge variant="outline">disabled</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {endpoint.stats.totalCalls} calls · {endpoint.stats.errorCalls} errors
          · avg {endpoint.stats.avgLatencyMs}ms · earned{" "}
          {formatWei(endpoint.stats.totalChargedWei)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-xs">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Price per call (wei)</Label>
            <Input
              value={pricePerCall}
              onChange={(e) => setPricePerCall(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Price per 1k tokens (wei)</Label>
            <Input
              value={pricePerK}
              onChange={(e) => setPricePerK(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label className="text-xs">Rate limit (per minute)</Label>
          <Input
            value={rateLimit}
            onChange={(e) => setRateLimit(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() =>
              onUpdate({
                name,
                pricePerCallWei: pricePerCall,
                pricePerKTokenWei: pricePerK,
                rateLimitPerMin: Math.max(1, Number(rateLimit) || 1),
              })
            }
            disabled={props.isUpdating}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onUpdate({ enabled: !endpoint.enabled })}
            disabled={props.isUpdating}
          >
            {endpoint.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={onDelete}
            disabled={props.isDeleting}
            className="ml-auto"
          >
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function KeysTab(props: { endpointId: number }) {
  const keys = useApiKeys(props.endpointId);
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey(props.endpointId);
  const [newName, setNewName] = useState("");
  const [showSecret, setShowSecret] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="py-4 flex gap-2 items-end">
          <div className="flex-1">
            <Label className="text-xs">New key name</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Acme Production"
            />
          </div>
          <Button
            size="sm"
            disabled={!newName.trim() || create.isPending}
            onClick={() =>
              create.mutate(
                { endpointId: props.endpointId, name: newName.trim() },
                {
                  onSuccess: (res) => {
                    setShowSecret(res.secret);
                    setNewName("");
                  },
                },
              )
            }
          >
            Generate
          </Button>
        </CardContent>
      </Card>

      {showSecret && (
        <Card className="border-amber-500">
          <CardHeader>
            <CardTitle className="text-base">Copy your secret now</CardTitle>
            <CardDescription>
              This is the only time you can see it. Store it in your password
              manager.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <code className="block break-all text-sm bg-muted p-2 rounded">
              {showSecret}
            </code>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(showSecret);
                }}
              >
                Copy
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowSecret(null)}
              >
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-2 space-y-1">
          {(keys.data ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground p-3">
              No keys yet. Generate one above.
            </div>
          )}
          {(keys.data ?? []).map((k) => (
            <div
              key={k.id}
              className="flex items-center gap-3 py-2 px-2 text-sm"
            >
              <div className="flex-1">
                <div className="font-medium">{k.name}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {k.keyPrefix}… ·{" "}
                  {k.lastUsedAt
                    ? `last used ${new Date(k.lastUsedAt).toLocaleString()}`
                    : "never used"}
                </div>
              </div>
              {k.revokedAt ? (
                <Badge variant="destructive">revoked</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => revoke.mutate(k.id)}
                  disabled={revoke.isPending}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function UsageTab(props: { endpointId: number }) {
  const usage = useApiUsage(props.endpointId);
  const rows = usage.data ?? [];
  const totals = useMemo(() => {
    let calls = 0;
    let errors = 0;
    let charged = 0n;
    for (const r of rows) {
      calls++;
      if (r.statusCode >= 400) errors++;
      try {
        charged += BigInt(r.chargedWei || "0");
      } catch {
        /* ignore */
      }
    }
    return { calls, errors, charged: charged.toString() };
  }, [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Recent usage ({totals.calls} calls · {totals.errors} errors · earned{" "}
          {formatWei(totals.charged)})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No calls yet — `curl` the endpoint with a valid key to see usage
            here.
          </div>
        ) : (
          <div className="text-xs font-mono space-y-1 max-h-96 overflow-auto">
            {rows.map((r) => (
              <div
                key={r.id}
                className={`grid grid-cols-[110px_60px_80px_80px_1fr] gap-2 py-1 ${
                  r.statusCode >= 400 ? "text-destructive" : ""
                }`}
              >
                <span>{new Date(r.createdAt).toLocaleTimeString()}</span>
                <span>HTTP {r.statusCode}</span>
                <span>{r.latencyMs}ms</span>
                <span>{formatWei(r.chargedWei)}</span>
                <span className="truncate">
                  {r.errorMessage ?? `out ${r.bytesOut}B · ${r.outputTokens} tok`}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
