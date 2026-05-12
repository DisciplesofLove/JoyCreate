import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "../root";
import BlueprintsPage from "@/pages/joy/BlueprintsPage";

export const joyBlueprintsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/joy/blueprints",
  component: BlueprintsPage,
});
