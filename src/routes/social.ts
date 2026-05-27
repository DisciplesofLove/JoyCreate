/**
 * Social posting route.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const socialRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/social",
  component: lazyRouteComponent(() => import("../pages/social")),
});
