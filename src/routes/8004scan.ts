import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const erc8004ScanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/8004scan",
  component: lazyRouteComponent(() => import("../pages/Erc8004ScanPage")),
});
