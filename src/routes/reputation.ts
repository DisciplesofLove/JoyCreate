import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const reputationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reputation",
  component: lazyRouteComponent(() => import("../pages/ReputationDashboard")),
});
