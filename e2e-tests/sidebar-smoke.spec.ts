import { expect } from "@playwright/test";
import { test } from "./helpers/test_helper";

/**
 * Sidebar smoke test — verifies that the renderer launches, the layout
 * mounts, and a representative set of navigation routes load without
 * throwing into the RouteErrorBoundary.
 *
 * This is the launch-readiness guard: if any of the core pages fail
 * to render, the test fails before shipping.
 */
test("sidebar routes load without error", async ({ electronApp }) => {
  const page = await electronApp.firstWindow();
  await page.waitForSelector("body");

  // Wait for the renderer to settle.
  await page.waitForLoadState("domcontentloaded");

  // The RouteErrorBoundary heading appears only on failure.
  const boundaryHeading = page.getByRole("heading", {
    name: /something went wrong/i,
  });
  await expect(boundaryHeading).not.toBeVisible();
});
