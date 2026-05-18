import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const geniusCoreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/genius-core",
  component: lazyRouteComponent(() => import("@/pages/GeniusCoreControlPanel")),
});
