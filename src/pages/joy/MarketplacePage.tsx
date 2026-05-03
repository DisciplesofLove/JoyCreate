/**
 * /joy/marketplace — Public Joy Marketplace browse.
 *
 * Replaces (functionally, not literally — D9 keep-old-pages):
 *   - /marketplace-explorer
 *   - /nft-marketplace (browse half)
 *
 * Backed by the on-chain DropERC1155 read layer via `marketplace:browse`
 * (see `src/lib/joymarketplace/drop_subgraph.ts` +
 * `src/ipc/handlers/marketplace_browse_handlers.ts`). The previous version
 * routed through `joybridge:browse-marketplace`, which depended on a cloud
 * endpoint that returns 404 — every published drop appeared as "no results"
 * in the UI even though the on-chain subgraph indexed them correctly.
 */

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
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
  PublishableAssetType,
} from "@/types/publish_types";
import { ShoppingCart, Search, Sparkles, Filter } from "lucide-react";

// Browse-page filter values. "all" is a UI-only sentinel mapped to undefined
// before passing to the IPC handler.
const ASSET_TYPES: Array<"all" | PublishableAssetType> = [
  "all",
  "agent",
  "workflow",
  "model",
  "dataset",
  "image",
  "video",
  "document",
];

export default function JoyMarketplacePage() {
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [assetType, setAssetType] = useState<"all" | PublishableAssetType>(
    "all",
  );

  const params: MarketplaceBrowseParams = useMemo(
    () => ({
      page: 1,
      pageSize: 24,
      sortBy: "recent",
      query: appliedSearch.trim() || undefined,
      assetType: assetType === "all" ? undefined : assetType,
    }),
    [appliedSearch, assetType],
  );

  const { data, isLoading, error } = useMarketplaceBrowse(params);
  const items = data?.items ?? [];

  function applyFilters(): void {
    setAppliedSearch(searchInput);
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
              placeholder="Search by name, store, tag…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
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
                {ASSET_TYPES.map((t) => (
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
            {error instanceof Error ? error.message : String(error)}
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="text-muted-foreground">Loading marketplace…</div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground space-y-2">
            <p>No published assets yet.</p>
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
                  {/* eslint-disable-next-line @next/next/no-img-element */}
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
                  <span>
                    {a.pricingModel === "free"
                      ? "Free"
                      : a.price != null
                        ? `${a.price.toFixed(4)} ${a.currency}`
                        : "—"}
                  </span>
                  <Badge variant="outline">{a.category}</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
