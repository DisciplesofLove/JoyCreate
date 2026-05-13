import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import AgentTracePage from "../pages/AgentTracePage";

export const agentTraceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agent-trace/$orchestrationId",
  component: AgentTracePage,
});
