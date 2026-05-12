import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { CopilotPanel } from "@/components/copilot/CopilotPanel";

export const copilotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/copilot",
  component: CopilotPanel,
});
