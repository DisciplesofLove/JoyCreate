import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const dataMarketRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/data-market",
  component: lazyRouteComponent(() => import("../pages/DataMarketPage")),
});
