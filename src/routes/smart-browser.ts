import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import SmartBrowserPage from "@/pages/SmartBrowserPage";

export const smartBrowserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/smart-browser",
  component: SmartBrowserPage,
});
