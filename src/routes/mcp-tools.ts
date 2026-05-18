/**
 * Built-in MCP Tools catalog route.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const mcpToolsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/mcp-tools",
  component: lazyRouteComponent(() => import("../pages/mcp-tools")),
});
