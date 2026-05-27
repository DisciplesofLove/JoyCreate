/**
 * Unified Command Center route — single-pane dashboard.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const commandCenterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/command-center",
  component: lazyRouteComponent(() => import("../pages/command-center")),
});
