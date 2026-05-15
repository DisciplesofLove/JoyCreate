import { createRoute, redirect } from "@tanstack/react-router";
import { rootRoute } from "./root";

// App Builder Studio is now embedded as a tab inside the workspace home ("/").
// This route is kept as a redirect so existing links keep working.
export const appBuilderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/app-builder",
  beforeLoad: () => {
    throw redirect({ to: "/", search: { appId: undefined } });
  },
});
