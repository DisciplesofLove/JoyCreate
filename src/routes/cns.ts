import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import React from "react";

// Use React.lazy() instead of TanStack Router's `.lazy()` because the latter
// expects the imported module to be a `LazyRoute` (created via
// `createLazyFileRoute`). Returning `{ component }` directly causes
// `TypeError: Cannot destructure property 'id' of 'lazyRoute.options'`.
const CNSPage = React.lazy(() => import("../pages/cns"));

export const cnsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cns",
  component: CNSPage,
});
