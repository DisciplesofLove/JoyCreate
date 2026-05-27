import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import DecentralizedDeployPage from "../pages/decentralized-deploy";

export const decentralizedDeployRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/decentralized-deploy",
  component: DecentralizedDeployPage,
  validateSearch: (search: Record<string, unknown>) => ({
    provider: typeof search.provider === "string" ? search.provider : undefined,
  }),
});
