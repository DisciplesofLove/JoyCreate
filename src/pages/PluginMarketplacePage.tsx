/**
 * Plugin Marketplace Page — DEPRECATED.
 *
 * Phase 2 nav consolidation (briefs/nav-consolidation-audit.md, Cluster 1):
 * the plugin browse experience now lives inside the unified Joy Marketplace
 * at `/joy/marketplace?type=plugin`. The Phase 1 PR already removed the
 * sidebar entry; this stub keeps the route resolvable so old bookmarks
 * don't 404.
 *
 * The previous full implementation (plugin install/manage UI backed by the
 * runtime plugin system) is preserved in version control and can be revived
 * if Terry decides plugins need their own dedicated install/manage cockpit
 * separate from the marketplace browse. For now: browse via Joy Marketplace.
 *
 * Note: this only deprecates the marketplace BROWSE half. Per the brief,
 * Phase 4 is the actual deletion sweep — we deprecate-don't-delete here.
 */

import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles, Puzzle } from "lucide-react";

export default function PluginMarketplacePage() {
  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-4 flex items-center gap-3 text-sm">
        <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="flex-1">
          <span className="font-medium">This page has moved.</span>{" "}
          <span className="text-muted-foreground">
            Plugins now live inside Joy Marketplace as a filter, alongside
            agents, workflows, apps, and other publishable assets.
          </span>
        </div>
        <Button size="sm" variant="outline" asChild>
          <Link
            to="/joy/marketplace"
            search={{ type: "plugin" as const }}
            className="inline-flex items-center gap-1 shrink-0"
          >
            Open Joy Marketplace → Plugins{" "}
            <ArrowRight className="h-3 w-3 ml-1" />
          </Link>
        </Button>
      </div>

      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Puzzle className="h-16 w-16 mb-4 opacity-40" />
        <h1 className="text-2xl font-bold mb-2 text-foreground">
          Plugin Marketplace
        </h1>
        <p className="max-w-md text-center text-sm">
          We've folded plugin browse into the unified Joy Marketplace so you
          have one place to discover everything publishable on JoyCreate.
        </p>
      </div>
    </div>
  );
}
