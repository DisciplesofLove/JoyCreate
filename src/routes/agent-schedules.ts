/**
 * Agent Schedules route — recurring agent runs.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const agentSchedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/schedules",
  component: lazyRouteComponent(() => import("../pages/agent-schedules")),
});
