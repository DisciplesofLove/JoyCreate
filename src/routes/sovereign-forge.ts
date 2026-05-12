import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import SovereignForgePage from "@/pages/SovereignForgePage";

export const sovereignForgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sovereign-forge",
  component: SovereignForgePage,
});
