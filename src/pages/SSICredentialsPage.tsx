/**
 * SSI Credentials Page — DEPRECATED.
 *
 * Phase 2 nav consolidation (briefs/nav-consolidation-audit.md, Cluster 5):
 * the SSI credentials body now lives inside the unified Identity page at
 * /identity?tab=ssi. This route still resolves so old bookmarks don't 404,
 * but it just renders a banner pointing users at the new location.
 *
 * The full implementation moved to:
 *   src/components/identity/me/SSICredentialsPanel.tsx
 */

import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles } from "lucide-react";

export default function SSICredentialsPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-6 max-w-3xl mx-auto w-full">
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-4 flex items-center gap-3 text-sm">
          <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            <span className="font-medium">This page has moved.</span>{" "}
            <span className="text-muted-foreground">
              SSI Credentials now live inside your unified Identity page.
            </span>
          </div>
          <Link
            to="/identity"
            search={{ tab: "ssi" as const }}
            className="inline-flex items-center gap-1 shrink-0"
          >
            <Button size="sm" variant="outline">
              Open Identity → SSI <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
