import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const apiGatewayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/api-gateway",
  component: lazyRouteComponent(() => import("../pages/ApiGatewayPage")),
});
