import { createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { rootRoute } from "../root";
import JoyMarketplacePage from "@/pages/joy/MarketplacePage";

// Phase 2 nav consolidation (briefs/nav-consolidation-audit.md, Cluster 1):
// the deprecated /plugin-marketplace route now redirects users here with
// `?type=plugin`. We accept any of the PublishableAssetType strings we expose
// in the dropdown.
const marketplaceTypeSchema = z
  .enum([
    "agent",
    "workflow",
    "app",
    "model",
    "dataset",
    "template",
    "plugin",
  ])
  .optional();

export const joyMarketplaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/joy/marketplace",
  component: JoyMarketplacePage,
  validateSearch: z.object({
    type: marketplaceTypeSchema,
  }),
});
