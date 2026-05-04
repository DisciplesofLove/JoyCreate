import { createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { rootRoute } from "../root";
import JoyMarketplacePage from "@/pages/joy/MarketplacePage";

/**
 * Single source of truth for the asset-type filter values exposed by
 * `/joy/marketplace`. The page imports this constant to render its dropdown,
 * and the route uses it to build the `validateSearch` Zod enum, so the URL
 * filter and the UI dropdown cannot drift.
 *
 * Phase 2 nav consolidation (briefs/nav-consolidation-audit.md, Cluster 1):
 * the deprecated /plugin-marketplace route now redirects users here with
 * `?type=plugin`. The full set mirrors `PublishableAssetType` so any deep
 * link constructed from a published asset's type round-trips.
 */
export const MARKETPLACE_TYPES = [
  "agent",
  "workflow",
  "app",
  "model",
  "dataset",
  "template",
  "component",
  "plugin",
] as const;
export type MarketplaceType = (typeof MARKETPLACE_TYPES)[number];

const marketplaceTypeSchema = z.enum(MARKETPLACE_TYPES).optional();

export const joyMarketplaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/joy/marketplace",
  component: JoyMarketplacePage,
  validateSearch: z.object({
    type: marketplaceTypeSchema,
  }),
});
