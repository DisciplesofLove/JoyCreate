import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import GauntletPage from "@/pages/gauntlet/GauntletPage";

export const gauntletRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gauntlet",
  component: GauntletPage,
});
