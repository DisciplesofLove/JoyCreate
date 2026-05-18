/**
 * Agent Observability route.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const agentObservabilityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/observability",
  component: lazyRouteComponent(() => import("../pages/agent-observability")),
});
