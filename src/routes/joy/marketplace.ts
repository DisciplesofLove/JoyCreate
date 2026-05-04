import { createRoute } from "@tanstack/react-router";
import { z } from "zod";
import { rootRoute } from "../root";
import JoyMarketplacePage from "@/pages/joy/MarketplacePage";
import { MARKETPLACE_TYPES, type MarketplaceType } from "./marketplace_types";

/**
 * Re-exported from `marketplace_types.ts` so existing call-sites that import
 * from `@/routes/joy/marketplace` keep working. The constants live in a
 * separate module to avoid a circular import between this route file and
 * the page component, which previously triggered
 *   "Cannot access 'MARKETPLACE_TYPES' before initialization"
 * at renderer boot (whole-app white screen).
 */
export { MARKETPLACE_TYPES };
export type { MarketplaceType };

const marketplaceTypeSchema = z.enum(MARKETPLACE_TYPES).optional();

export const joyMarketplaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/joy/marketplace",
  component: JoyMarketplacePage,
  validateSearch: z.object({
    type: marketplaceTypeSchema,
  }),
});
