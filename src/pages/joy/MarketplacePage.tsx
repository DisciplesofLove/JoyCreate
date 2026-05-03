/**
 * /joy/marketplace — Public Joy Marketplace browse.
 *
 * Section C of `briefs/droperc1155-read-layer-surgery.md`: this page used to
 * route through `joybridge:browse-marketplace`. It now reads directly from
 * the DropERC1155 Goldsky subgraph via `useMarketplaceBrowse`, the same hook
 * powering `/marketplace-explorer` and `/nft-marketplace`. One read path.
 * Replaces (functionally, not literally — D9 keep-old-pages):
 *   - /marketplace-explorer
 *   - /nft-marketplace (browse half)
 *   - /plugin-marketplace (Phase 2 nav consolidation, Cluster 1: now exposed
 *     via the `?type=plugin` filter and the "plugin" entry in the type
 *     dropdown — see briefs/nav-consolidation-audit.md)
 *
 * URL search params:
 *   ?type=plugin|agent|workflow|app|model|dataset|template — pre-selects the
 *   asset-type filter on mount. Useful for deep links from the deprecated
 *   /plugin-marketplace banner.
 *
 * Backed by the on-chain DropERC1155 read layer via `marketplace:browse`
 * (see `src/lib/joymarketplace/drop_subgraph.ts` +
 * `src/ipc/handlers/marketplace_browse_handlers.ts`). The previous version
 * routed through `joybridge:browse-marketplace`, which depended on a cloud
 * endpoint that returns 404 — every published drop appeared as "no results"
 * in the UI even though the on-chain subgraph indexed them correctly.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMarketplaceBrowse } from "@/hooks/use_marketplace_browse";
import type {
  MarketplaceBrowseParams,
  MarketplaceBrowseItem,
  PublishableAssetType,
} from "@/types/publish_types";
import { ShoppingCart, Search, Sparkles, Filter } from "lucide-react";

// Asset types this page exposes as filters. The hook accepts any
// PublishableAssetType plus the literal "all" (mapped to `undefined`).
// Phase 2 nav consolidation: `plugin` is intentionally surfaced here so
// the deprecated /plugin-marketplace route can deep-link in via
// `/joy/marketplace?type=plugin`.
const ASSET_TYPE_OPTIONS: ReadonlyArray<"all" | PublishableAssetType> = [
  "all",
  "agent",
  "workflow",
  "app",
  "model",
  "dataset",
  "template",
  "plugin",
] as const;

const VALID_TYPES = new Set<string>(ASSET_TYPE_OPTIONS);

export default function JoyMarketplacePage() {
  const search = useSearch({ from: "/joy/marketplace" });
  const navigate = useNavigate();
  const initialType: "all" | PublishableAssetType =
    search?.type && VALID_TYPES.has(search.type)
      ? (search.type as "all" | PublishableAssetType)
      : "all";

  const [searchText, setSearchText] = useState("");
  const [assetType, setAssetType] = useState<"all" | PublishableAssetType>(
    initialType,
  );
  const [appliedSearch, setAppliedSearch] = useState("");
  const [appliedAssetType, setAppliedAssetType] =
    useState<"all" | PublishableAssetType>(initialType);

  // Sync incoming `?type=` URL changes into the applied filter so deep links
  // from the /plugin-marketplace deprecation banner pre-filter on mount AND
  // after navigation while the page is already mounted.
  useEffect(() => {
    const incoming: "all" | PublishableAssetType =
      search?.type && VALID_TYPES.has(search.type)
        ? (search.type as "all" | PublishableAssetType)
        : "all";
    setAssetType(incoming);
    setAppliedAssetType(incoming);
  }, [search?.type]);

  const params: MarketplaceBrowseParams = {
    query: appliedSearch || undefined,
    assetType: appliedAssetType === "all" ? undefined : appliedAssetType,
    pageSize: 24,
  };

  const { data, isLoading, error } = useMarketplaceBrowse(params);
  const items: MarketplaceBrowseItem[] = data?.items ?? [];

  function applyFilters(): void {
    setAppliedSearch(searchText.trim());
    setAppliedAssetType(assetType);
    // Reflect the current type filter in the URL so it's shareable /
    // back-button friendly. Drop the param when "all".
    void navigate({
      to: "/joy/marketplace",
      search:
        assetType === "all"
          ? {}
          : { type: assetType as PublishableAssetType },
      replace: true,
    });
  }

  function priceLabel(item: MarketplaceBrowseItem): string {
    if (item.pricingModel === "free" || (item.price ?? 0) === 0) return "Free";
    // `price` is the display value (whole units) from the on-chain read
    // layer (`weiToDisplay` in marketplace_browse_handlers). Render it
    // alongside the chain-native `currency` rather than re-scaling.
    return `${(item.price ?? 0).toFixed(4)} ${item.currency}`;
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-8 w-8 text-purple-500" />
            Joy Marketplace
          </h1>
          <p className="text-muted-foreground">
            Browse on-chain DropERC1155 assets published from JoyCreate stores.
          </p>
        </div>
        <Link to="/joy/publish">
          <Button>
            <Sparkles className="h-4 w-4 mr-2" />
            Publish an Asset
          </Button>
        </Link>
      </header>

      <Card>
        <CardContent className="p-4 flex flex-col md:flex-row gap-3">
          <div className="flex-1 flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, tag…"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFilters();
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select
              value={assetType}
              onValueChange={(v) =>
                setAssetType(v as "all" | PublishableAssetType)
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === "all" ? "All types" : t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={applyFilters} variant="secondary">
              Apply
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="p-6 text-center text-red-600 dark:text-red-400">
            {error instanceof Error ? error.message : "Failed to load marketplace"}
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="text-muted-foreground">Loading marketplace…</div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground space-y-2">
            <p>
              {appliedAssetType === "plugin"
                ? "No plugins published yet."
                : "No published assets yet."}
            </p>
            <p className="text-sm">
              When you (or anyone) publishes via{" "}
              <Link to="/joy/publish" className="underline">
                /joy/publish
              </Link>
              , assets will show up here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {items.map((a) => (
            <Card
              key={a.id}
              className="overflow-hidden hover:shadow-md transition-shadow"
            >
              {a.thumbnailUrl ? (
                <div className="h-40 bg-muted">
                  <img
                    src={a.thumbnailUrl}
                    alt={a.name}
                    className="h-full w-full object-cover"
                  />
                </div>
              ) : (
                <div className="h-40 bg-gradient-to-br from-purple-500/20 to-indigo-500/20 flex items-center justify-center">
                  <Sparkles className="h-10 w-10 text-purple-500/50" />
                </div>
              )}
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="truncate">{a.name}</span>
                  <Badge variant="secondary">{a.assetType}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-1">
                {a.shortDescription && (
                  <p className="line-clamp-2">{a.shortDescription}</p>
                )}
                <div className="flex items-center justify-between pt-2">
                  <span>{priceLabel(a)}</span>
                  <Badge variant="outline">published</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
