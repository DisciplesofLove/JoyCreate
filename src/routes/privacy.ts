import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "./root";

export const privacySettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: lazyRouteComponent(() => import("../pages/PrivacySettingsPage")),
});
