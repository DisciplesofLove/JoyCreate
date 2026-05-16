import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import EarningsPage from "@/pages/EarningsPage";

export const earningsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/earnings",
  component: EarningsPage,
});
