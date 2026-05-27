/**
 * Brand Kit route — voice / palette / fonts injected into agent prompts.
 */

import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const brandKitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/brand-kit",
  component: lazyRouteComponent(() => import("../pages/brand-kit")),
});
