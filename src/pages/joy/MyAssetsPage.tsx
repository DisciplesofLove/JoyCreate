/**
 * /joy/my-assets — list everything the user has published.
 *
 * Three views, switchable via tabs:
 *  • All       — joybridge edge function (`joybridge:list-my-assets`).
 *  • Amoy      — on-chain DropERC1155 subgraph (Polygon Amoy).
 *  • Sepolia   — on-chain DropERC1155 subgraph (Arbitrum Sepolia).
 *
 * The on-chain tabs use the wallet returned by `useConnectedWallet()` and
 * route through `marketplace:my-drops` with the chosen `chainId`. When
 * no wallet is connected those tabs show a connect-wallet CTA rather
 * than firing the query.
 */

import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IpcClient } from "@/ipc/ipc_client";
import { Package, Plus, Sparkles, Wallet } from "lucide-react";
import type { Asset, Result } from "@/lib/joybridge_client";
import type {
  MarketplaceBrowseItem,
  MarketplaceSubgraphChainId,
} from "@/types/publish_types";
import {
  MonetizeButton,
  type MonetizationConfig,
} from "@/components/monetization/MonetizeButton";
import { showSuccess } from "@/lib/toast";
import { useConnectedWallet } from "@/hooks/useConnectedWallet";
import { useMyDropsByChain } from "@/hooks/useMyDropsByChain";

type TabId = "all" | MarketplaceSubgraphChainId;

const CHAIN_LABELS: Record<MarketplaceSubgraphChainId, string> = {
  polygonAmoy: "Polygon Amoy",
  arbitrumSepolia: "Arbitrum Sepolia",
};

export default function JoyMyAssetsPage() {
  const [tab, setTab] = useState<TabId>("all");
  const { address: walletAddress } = useConnectedWallet();

  return (
    <div className="container mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Package className="h-8 w-8 text-violet-500" />
            My Assets
          </h1>
          <p className="text-muted-foreground">
            Everything you've published to the Joy Marketplace.
          </p>
        </div>
        <Link to="/joy/publish">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Publish New
          </Button>
        </Link>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="polygonAmoy">
            {CHAIN_LABELS.polygonAmoy}
          </TabsTrigger>
          <TabsTrigger value="arbitrumSepolia">
            {CHAIN_LABELS.arbitrumSepolia}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-4">
          <JoybridgeAssetsTab />
        </TabsContent>

        <TabsContent value="polygonAmoy" className="mt-4">
          <SubgraphAssetsTab chainId="polygonAmoy" wallet={walletAddress} />
        </TabsContent>

        <TabsContent value="arbitrumSepolia" className="mt-4">
          <SubgraphAssetsTab chainId="arbitrumSepolia" wallet={walletAddress} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── "All" tab (joybridge edge function) ──────────────────────────────────

function JoybridgeAssetsTab() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const ipc = IpcClient.getInstance();
      const res = (await ipc.invoke("joybridge:list-my-assets")) as Result<
        Asset[] | { assets?: Asset[]; data?: Asset[] }
      >;
      if (res?.ok) {
        const raw = res.data as unknown;
        const list: Asset[] = Array.isArray(raw)
          ? (raw as Asset[])
          : Array.isArray((raw as { assets?: unknown })?.assets)
            ? ((raw as { assets: Asset[] }).assets)
            : Array.isArray((raw as { data?: unknown })?.data)
              ? ((raw as { data: Asset[] }).data)
              : [];
        setAssets(list);
      } else setError(res?.error ?? "Failed to load assets");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-red-600 dark:text-red-400">
          {error}
        </CardContent>
      </Card>
    );
  }
  if (loading) {
    return <div className="text-muted-foreground">Loading your assets…</div>;
  }
  if (assets.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center text-muted-foreground space-y-2">
          <p>You haven't published anything yet.</p>
          <p className="text-sm">
            Open any studio (Image, Video, Agent, Model, Document) and click{" "}
            <strong>Publish to Marketplace</strong>, or use the{" "}
            <Link to="/joy/publish" className="underline">
              Publish wizard
            </Link>{" "}
            directly.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {assets.map((a) => (
        <Card key={a.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="truncate">{a.name}</span>
              <Badge variant="secondary">{a.assetType}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {a.description && (
              <p className="text-muted-foreground line-clamp-2">
                {a.description}
              </p>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                {a.priceUsdc != null
                  ? a.priceUsdc === 0
                    ? "Free"
                    : `$${(a.priceUsdc / 1_000_000).toFixed(2)} USDC`
                  : "—"}
              </span>
              {a.status && <Badge variant="outline">{a.status}</Badge>}
            </div>
            {a.tokenId && (
              <p className="text-xs text-muted-foreground font-mono break-all">
                token: {a.tokenId.slice(0, 18)}…
              </p>
            )}
            <div className="flex items-center gap-1 pt-2 text-xs text-muted-foreground">
              <Sparkles className="h-3 w-3" />
              <span>Created {a.createdAt ?? "recently"}</span>
            </div>
            <div className="pt-2">
              <MonetizeButton
                assetLabel={a.name}
                initial={
                  a.priceUsdc != null
                    ? {
                        model: a.priceUsdc === 0 ? "free" : "one-time",
                        price:
                          a.priceUsdc === 0
                            ? ""
                            : (a.priceUsdc / 1_000_000).toFixed(2),
                        currency: "USD",
                        royaltyPercent: 0,
                        billingPeriod: "monthly",
                      }
                    : undefined
                }
                onSubmit={(config: MonetizationConfig) => {
                  const summary =
                    config.model === "free"
                      ? "Free"
                      : `${config.model} · ${config.price} ${config.currency}`;
                  showSuccess(
                    `Monetization saved for "${a.name}": ${summary}.`,
                  );
                }}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Subgraph tab (per chain) ─────────────────────────────────────────────

function SubgraphAssetsTab({
  chainId,
  wallet,
}: {
  chainId: MarketplaceSubgraphChainId;
  wallet: string | null;
}) {
  const query = useMyDropsByChain({ wallet, chainId });

  if (!wallet) {
    return (
      <Card>
        <CardContent className="p-12 text-center text-muted-foreground space-y-3">
          <Wallet className="h-8 w-8 mx-auto text-violet-500" />
          <p>
            Connect a wallet to view your on-chain drops on{" "}
            <strong>{CHAIN_LABELS[chainId]}</strong>.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground">
        Loading {CHAIN_LABELS[chainId]} drops…
      </div>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardContent className="p-4 text-red-600 dark:text-red-400">
          {query.error instanceof Error
            ? query.error.message
            : "Failed to load drops"}
        </CardContent>
      </Card>
    );
  }

  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center text-muted-foreground space-y-2">
          <p>
            No drops found for this wallet on{" "}
            <strong>{CHAIN_LABELS[chainId]}</strong>.
          </p>
          <p className="text-xs font-mono break-all">{wallet}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {items.map((item) => (
        <SubgraphDropCard key={item.id} item={item} chainId={chainId} />
      ))}
    </div>
  );
}

function SubgraphDropCard({
  item,
  chainId,
}: {
  item: MarketplaceBrowseItem;
  chainId: MarketplaceSubgraphChainId;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="truncate">{item.name}</span>
          <Badge variant="secondary">{item.assetType}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {item.shortDescription && (
          <p className="text-muted-foreground line-clamp-2">
            {item.shortDescription}
          </p>
        )}
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">
            {item.pricingModel === "free" || item.price == null
              ? "Free"
              : `${item.price} ${item.currency}`}
          </span>
          <Badge variant="outline">{CHAIN_LABELS[chainId]}</Badge>
        </div>
        <p className="text-xs text-muted-foreground font-mono break-all">
          token: {item.id.slice(0, 18)}…
        </p>
        <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
          <span>{item.downloads.toLocaleString()} claims</span>
          <span>Published {item.publishedAt || "—"}</span>
        </div>
      </CardContent>
    </Card>
  );
}
