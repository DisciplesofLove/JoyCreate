import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { z } from "zod";
import { rootRoute } from "./root";

const identityTabSchema = z
  .enum(["identity", "public", "ssi", "account", "activity"])
  .optional();

export const unifiedIdentityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/identity",
  component: lazyRouteComponent(() => import("@/pages/UnifiedIdentityPage")),
  validateSearch: z.object({
    tab: identityTabSchema,
  }),
});
