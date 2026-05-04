import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { z } from "zod";
import { rootRoute } from "./root";

/**
 * Single source of truth for the /identity tab list. The page imports this
 * constant to derive its `IdentityTab` union, and the route uses it to build
 * the `validateSearch` Zod enum, so the two cannot drift.
 */
export const IDENTITY_TABS = [
  "identity",
  "public",
  "ssi",
  "account",
  "activity",
] as const;
export type IdentityTab = (typeof IDENTITY_TABS)[number];

const identityTabSchema = z.enum(IDENTITY_TABS).optional();

export const unifiedIdentityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/identity",
  component: lazyRouteComponent(() => import("@/pages/UnifiedIdentityPage")),
  validateSearch: z.object({
    tab: identityTabSchema,
  }),
});
