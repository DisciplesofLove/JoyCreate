/**
 * EarningsPage
 *
 * Phase 5 (M1) Monetization: a single dashboard surfacing every revenue
 * stream a creator can earn from inside JoyCreate. Today these payouts
 * are scattered across Joy Marketplace (DropERC1155 sales + royalties),
 * Compute Network payouts, Tokenomics rewards, and (forthcoming) agent
 * service revenue / subscriptions. The Earnings page is the canonical
 * "show me the money" surface — no money flows are added or removed by
 * this page; it only aggregates what already exists.
 *
 * Live data sources wired:
 *   - Marketplace tab → `useMyDrops(wallet)` (Goldsky `joy-drop-amoy`
 *     subgraph via `marketplace:my-drops` IPC). Counts are derived from
 *     DropERC1155 lazy-mints authored by the connected wallet.
 *   - Compute tab → `useComputeJobStats()` (`earnings24h` bigint).
 *
 * The remaining tabs (agents / subscriptions / tokens) stay as
 * scaffolds until their ledgers exist (Phase 5 M3 + M5).
 */

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CircleDollarSign,
  ShoppingCart,
  Cpu,
  Bot,
  Repeat,
  Sparkles,
  TrendingUp,
  Loader2,
  Wallet,
  ExternalLink,
} from "lucide-react";
import { useConnectedWallet } from "@/hooks/useConnectedWallet";
import {
  useMyDrops,
  useMyClaims,
  useMyStores,
  useMyRevenue,
} from "@/hooks/use_marketplace_browse";
import { useComputeJobStats } from "@/hooks/useComputeNetwork";
import {
  useAgentRentalEarnings,
  useSubscriptionEarnings,
  useEarningsSummary,
} from "@/hooks/useEarnings";

type EarningsStream = {
  value: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  cta: { label: string; to: string };
  status: "live" | "scaffold";
};

const STREAMS: EarningsStream[] = [
  {
    value: "marketplace",
    label: "Marketplace",
    icon: ShoppingCart,
    description:
      "Primary sales and royalties from DropERC1155 listings published to the Joy marketplace.",
    cta: { label: "Open Joy Marketplace", to: "/joy/marketplace" },
    status: "live",
  },
  {
    value: "compute",
    label: "Compute",
    icon: Cpu,
    description:
      "Earnings from contributing compute, storage, and bandwidth to the JoyCreate compute network.",
    cta: { label: "Open Compute", to: "/compute" },
    status: "live",
  },
  {
    value: "agents",
    label: "Agent Services",
    icon: Bot,
    description:
      "Pay-per-call revenue when other users invoke agents you've published. Wires to the upcoming agent billing meter.",
    cta: { label: "Open Agents", to: "/agents" },
    status: "live",
  },
  {
    value: "subscriptions",
    label: "Subscriptions",
    icon: Repeat,
    description:
      "Recurring revenue from paid blueprints, plugins, and hosted apps. Configured per asset via the Monetize button.",
    cta: { label: "Open Blueprints", to: "/joy/blueprints" },
    status: "live",
  },
  {
    value: "tokens",
    label: "Token Rewards",
    icon: Sparkles,
    description:
      "Tokenomics payouts: governance rewards, staking yield, and creator grants surfaced as a unified feed.",
    cta: { label: "Open Token Economics", to: "/tokenomics" },
    status: "scaffold",
  },
];

function StreamHeader({ stream }: { stream: EarningsStream }) {
  const Icon = stream.icon;
  return (
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-muted p-2">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <CardTitle className="text-base">{stream.label}</CardTitle>
          <CardDescription>{stream.description}</CardDescription>
        </div>
      </div>
      <Badge variant="outline" className="capitalize">
        {stream.status}
      </Badge>
    </div>
  );
}

function StreamEmptyState({ stream }: { stream: EarningsStream }) {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <StreamHeader stream={stream} />
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          No payouts to display yet. Set up monetization on a publishable asset
          and earnings will appear here.
        </p>
        <Button asChild variant="secondary" size="sm">
          <Link to={stream.cta.to}>{stream.cta.label}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Marketplace tab — live Goldsky drop subgraph reads
// ---------------------------------------------------------------------------

function MarketplaceTab({ stream }: { stream: EarningsStream }) {
  const { address } = useConnectedWallet();
  const myDrops = useMyDrops(address);
  const myClaims = useMyClaims(address);
  const myStores = useMyStores(address);
  const myRevenue = useMyRevenue(address);

  if (!address) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <StreamHeader stream={stream} />
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Connect a wallet to see drops you've published and accrued
            royalties from the Goldsky drop subgraph.
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link to="/identity">
              <Wallet className="mr-2 h-4 w-4" />
              Connect wallet
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (myDrops.isLoading) {
    return (
      <Card>
        <CardHeader>
          <StreamHeader stream={stream} />
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading drops from Goldsky…
        </CardContent>
      </Card>
    );
  }

  if (myDrops.isError) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <StreamHeader stream={stream} />
        </CardHeader>
        <CardContent className="text-sm text-destructive">
          Failed to load drops:{" "}
          {(myDrops.error as Error)?.message ?? "unknown error"}
        </CardContent>
      </Card>
    );
  }

  const items = myDrops.data?.items ?? [];
  const total = myDrops.data?.total ?? items.length;
  const claims = myClaims.data ?? [];
  const stores = myStores.data ?? [];
  const totalUnitsBought = claims.reduce((acc, c) => {
    try {
      return acc + BigInt(c.quantity ?? "0");
    } catch {
      return acc;
    }
  }, 0n);

  return (
    <Card>
      <CardHeader>
        <StreamHeader stream={stream} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Published drops</p>
            <p className="text-2xl font-semibold">{total}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">My stores</p>
            <p className="text-2xl font-semibold">
              {myStores.isLoading ? "…" : stores.length}
            </p>
            <p className="text-xs text-muted-foreground">joy-stores-amoy</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Units claimed (you)</p>
            <p className="text-2xl font-semibold">
              {myClaims.isLoading ? "…" : totalUnitsBought.toString()}
            </p>
            <p className="text-xs text-muted-foreground">{claims.length} txs</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Network</p>
            <p className="text-sm">Polygon Amoy · Goldsky</p>
            <p className="font-mono text-[10px] break-all text-muted-foreground">
              {address}
            </p>
          </div>
        </div>

        {stores.length > 0 && (
          <div className="rounded-md border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Stores
            </p>
            <div className="flex flex-wrap gap-2">
              {stores.map((s) => (
                <Badge key={s.id} variant="secondary">
                  {s.name ?? s.id}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {myRevenue.data && myRevenue.data.rows.length > 0 && (
          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                Sales revenue (units sold × price)
              </p>
              <p className="text-xs text-muted-foreground">
                {myRevenue.data.totalUnitsSold} units total
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {Object.entries(myRevenue.data.totalsByCurrency).map(
                ([currency, wei]) => (
                  <div key={currency} className="rounded-md bg-muted px-3 py-2">
                    <p className="text-lg font-semibold">{formatWei(BigInt(wei))}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {currency === "native"
                        ? "Native (MATIC)"
                        : `${currency.slice(0, 6)}…${currency.slice(-4)}`}
                    </p>
                  </div>
                ),
              )}
            </div>
          </div>
        )}

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No drops authored yet. Publish an agent or workflow to mint your
            first DropERC1155.
          </p>
        ) : (
          <div className="space-y-2">
            {items.slice(0, 8).map((it) => {
              const priceLabel =
                it.pricingModel === "free" || it.price == null
                  ? "Free"
                  : `${it.price} ${it.currency ?? "USDC"}`;
              return (
                <div
                  key={it.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{it.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Token #{it.id} · {it.assetType}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      {priceLabel}
                    </span>
                    <Button asChild variant="ghost" size="sm">
                      <Link to="/joy/marketplace">
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex justify-end">
          <Button asChild variant="secondary" size="sm">
            <Link to={stream.cta.to}>{stream.cta.label}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Compute tab — live compute network job stats
// ---------------------------------------------------------------------------

function formatWei(wei: bigint | undefined | null): string {
  if (wei === undefined || wei === null) return "0";
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = abs % 10n ** 18n;
  const fracStr = frac
    .toString()
    .padStart(18, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${out}` : out;
}

function ComputeTab({ stream }: { stream: EarningsStream }) {
  const stats = useComputeJobStats({ refetchInterval: 30_000 });

  if (stats.isLoading) {
    return (
      <Card>
        <CardHeader>
          <StreamHeader stream={stream} />
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading compute stats…
        </CardContent>
      </Card>
    );
  }

  if (stats.isError || !stats.data) {
    return <StreamEmptyState stream={stream} />;
  }

  const { earnings24h, completedLastHour, successRate, totalTokensProcessed } =
    stats.data;

  return (
    <Card>
      <CardHeader>
        <StreamHeader stream={stream} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Earnings (24h)</p>
            <p className="text-2xl font-semibold">{formatWei(earnings24h)}</p>
            <p className="text-xs text-muted-foreground">native units</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Jobs (1h)</p>
            <p className="text-2xl font-semibold">{completedLastHour}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Success rate</p>
            <p className="text-2xl font-semibold">
              {Math.round((successRate ?? 0) * 100)}%
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Tokens processed</p>
            <p className="text-2xl font-semibold">
              {totalTokensProcessed.toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button asChild variant="secondary" size="sm">
            <Link to={stream.cta.to}>{stream.cta.label}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCards() {
  const { address } = useConnectedWallet();
  const myDrops = useMyDrops(address);
  const stats = useComputeJobStats({ refetchInterval: 60_000 });

  const activeAssets = myDrops.data?.total ?? 0;
  const lifetimeLabel = useMemo(() => {
    if (!stats.data?.earnings24h) return "—";
    return `${formatWei(stats.data.earnings24h)} (24h compute)`;
  }, [stats.data?.earnings24h]);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Compute earnings (24h)</CardDescription>
          <CardTitle className="text-2xl">
            {stats.data ? formatWei(stats.data.earnings24h) : "—"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Live from the local compute network telemetry stream.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Marketplace + compute</CardDescription>
          <CardTitle className="text-2xl">{lifetimeLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Marketplace royalties indexed by Goldsky will be added here once
            the on-chain claim ledger lands.
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Active monetized assets</CardDescription>
          <CardTitle className="text-2xl">
            {address ? activeAssets : "—"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            DropERC1155 lazy-mints authored by the connected wallet.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agents tab — agent rental ledger (Phase 1B)
// ---------------------------------------------------------------------------

function formatUsdc(baseUnits: string): string {
  try {
    const n = BigInt(baseUnits);
    const whole = n / 1_000_000n;
    const frac = (n % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
    return `$${whole.toString()}.${frac}`;
  } catch {
    return "$0.00";
  }
}

function AgentsTab({ stream }: { stream: EarningsStream }) {
  const earningsQ = useAgentRentalEarnings();
  const summaryQ = useEarningsSummary();
  const rows = earningsQ.data ?? [];
  const totalUsdc = summaryQ.data?.agentTotalUsdc ?? "0";

  if (earningsQ.isLoading) {
    return (
      <Card>
        <CardHeader><StreamHeader stream={stream} /></CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading agent rental earnings…
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader><StreamHeader stream={stream} /></CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            No agent rental payouts yet. Once another user rents one of your
            published agents, payouts will appear here.
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link to={stream.cta.to}>{stream.cta.label}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <StreamHeader stream={stream} />
        <CardDescription>
          Lifetime: <strong>{formatUsdc(totalUsdc)}</strong> across {rows.length} payouts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center justify-between border-b border-border/30 py-2 text-sm">
              <div>
                <div className="font-medium">{row.agentName}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(row.earnedAt).toLocaleString()}
                  {row.renterAddress && ` · ${row.renterAddress.slice(0, 6)}…${row.renterAddress.slice(-4)}`}
                </div>
              </div>
              <div className="font-mono">{formatUsdc(row.amountUsdc)}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Subscriptions tab — recurring revenue ledger (Phase 1B)
// ---------------------------------------------------------------------------

function SubscriptionsTab({ stream }: { stream: EarningsStream }) {
  const earningsQ = useSubscriptionEarnings();
  const summaryQ = useEarningsSummary();
  const rows = earningsQ.data ?? [];
  const totalUsdc = summaryQ.data?.subscriptionTotalUsdc ?? "0";

  if (earningsQ.isLoading) {
    return (
      <Card>
        <CardHeader><StreamHeader stream={stream} /></CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading subscription earnings…
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card className="border-dashed">
        <CardHeader><StreamHeader stream={stream} /></CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            No subscription payouts yet. Configure a paid blueprint or plugin
            and recurring revenue will appear here.
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link to={stream.cta.to}>{stream.cta.label}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <StreamHeader stream={stream} />
        <CardDescription>
          Lifetime: <strong>{formatUsdc(totalUsdc)}</strong> across {rows.length} payouts.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center justify-between border-b border-border/30 py-2 text-sm">
              <div>
                <div className="font-medium">{row.planName}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(row.earnedAt).toLocaleString()}
                  {row.subscriberAddress && ` · ${row.subscriberAddress.slice(0, 6)}…${row.subscriberAddress.slice(-4)}`}
                </div>
              </div>
              <div className="font-mono">{formatUsdc(row.amountUsdc)}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function EarningsPage() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/50 bg-gradient-to-r from-amber-500/5 via-orange-500/5 to-rose-500/5 p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-3 text-2xl font-bold">
              <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/20 to-orange-500/20 p-2">
                <CircleDollarSign className="h-6 w-6 text-amber-500" />
              </div>
              <span className="bg-gradient-to-r from-amber-600 to-orange-600 bg-clip-text text-transparent">
                Earnings
              </span>
            </h1>
            <p className="mt-1 text-muted-foreground">
              Every revenue stream from your published assets, agents, compute,
              and tokens — in one place.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/analytics">
              <TrendingUp className="mr-2 h-4 w-4" />
              View analytics
            </Link>
          </Button>
        </div>
        <SummaryCards />
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <Tabs defaultValue="marketplace" className="space-y-4">
          <TabsList>
            {STREAMS.map((stream) => {
              const Icon = stream.icon;
              return (
                <TabsTrigger key={stream.value} value={stream.value}>
                  <Icon className="mr-2 h-4 w-4" />
                  {stream.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {STREAMS.map((stream) => (
            <TabsContent key={stream.value} value={stream.value}>
              {stream.value === "marketplace" ? (
                <MarketplaceTab stream={stream} />
              ) : stream.value === "compute" ? (
                <ComputeTab stream={stream} />
              ) : stream.value === "agents" ? (
                <AgentsTab stream={stream} />
              ) : stream.value === "subscriptions" ? (
                <SubscriptionsTab stream={stream} />
              ) : (
                <StreamEmptyState stream={stream} />
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
