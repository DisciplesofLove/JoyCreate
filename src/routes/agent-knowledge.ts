/**
 * Agent Knowledge Base route.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const agentKnowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/knowledge",
  component: lazyRouteComponent(() => import("../pages/agent-knowledge")),
});
