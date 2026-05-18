import { createRootRoute, Outlet } from "@tanstack/react-router";
import Layout from "../app/layout";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";

export const rootRoute = createRootRoute({
  component: () => (
    <Layout>
      <RouteErrorBoundary>
        <Outlet />
      </RouteErrorBoundary>
    </Layout>
  ),
});
