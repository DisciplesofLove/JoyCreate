/**
 * Featured Tasks route — one-shot autonomous task gallery.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const featuredTasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tasks/featured",
  component: lazyRouteComponent(() => import("../pages/featured-tasks")),
});
