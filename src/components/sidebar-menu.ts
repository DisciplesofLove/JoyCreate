import type { ComponentType } from "react";
import type { SidebarPreferences } from "@/lib/schemas";

/**
 * Development stage of a sidebar item.
 * - `undefined` (absent): stable — shown by default unless the user hides it.
 * - `"beta"`: hidden by default; revealed by the "Show beta" master switch or
 *   an explicit per-item enable.
 * - `"dev"`: hidden by default; revealed by the "Show in-development" master
 *   switch or an explicit per-item enable.
 */
export type SidebarStage = "beta" | "dev";

/** Minimal structural shape shared by every navigation item. */
export type SidebarNavItem = {
  title: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
  gradient?: string;
  hoverBg?: string;
  activeBg?: string;
  activeText?: string;
};

export type SidebarNavCategory<T extends SidebarNavItem = SidebarNavItem> = {
  label: string;
  items: T[];
};

/**
 * Stage tagging for individual sidebar items, keyed by the item's route
 * (`to`). Add an entry here to mark an item as beta or in-development — no need
 * to touch the large `menuCategories` array. Items without an entry are stable.
 *
 * Example:
 *   export const SIDEBAR_STAGE_OVERRIDES = {
 *     "/nlp-studio": "beta",
 *     "/gauntlet": "dev",
 *   } as const;
 */
export const SIDEBAR_STAGE_OVERRIDES: Record<string, SidebarStage> = {};

/** Stable identifier for a sidebar item. The route is unique per item. */
export function sidebarItemId(item: { to: string }): string {
  return item.to;
}

/** Returns the tagged stage for an item, or `undefined` when stable. */
export function getSidebarItemStage(item: {
  to: string;
}): SidebarStage | undefined {
  return SIDEBAR_STAGE_OVERRIDES[item.to];
}

/**
 * Determines whether a sidebar item should be shown given the user's
 * preferences.
 *
 * - Stable items are visible unless explicitly hidden.
 * - Beta/dev items are hidden by default; they become visible when the matching
 *   master switch is on OR the item is individually enabled — but an explicit
 *   hide always wins.
 */
export function isSidebarItemVisible(
  item: { to: string },
  prefs: SidebarPreferences | undefined | null,
): boolean {
  const id = sidebarItemId(item);
  const hidden = prefs?.hiddenItems?.includes(id) ?? false;
  const stage = getSidebarItemStage(item);

  if (!stage) {
    // Stable item.
    return !hidden;
  }

  if (hidden) {
    return false;
  }

  const enabledIndividually = prefs?.enabledItems?.includes(id) ?? false;
  const enabledByStage =
    (stage === "beta" && !!prefs?.showBeta) ||
    (stage === "dev" && !!prefs?.showDev);

  return enabledIndividually || enabledByStage;
}

/**
 * Filters categories down to the items the user should see, dropping any
 * category that ends up empty so its label isn't rendered alone.
 */
export function filterVisibleCategories<
  T extends SidebarNavItem,
  C extends SidebarNavCategory<T>,
>(categories: C[], prefs: SidebarPreferences | undefined | null): C[] {
  return categories
    .map((category) => ({
      ...category,
      items: category.items.filter((item) => isSidebarItemVisible(item, prefs)),
    }))
    .filter((category) => category.items.length > 0) as C[];
}

/**
 * Flattens categories into a single list, preserving each item's category
 * label. Used by the customization UI to render one toggle per item.
 */
export function getAllSidebarItems<
  T extends SidebarNavItem,
  C extends SidebarNavCategory<T>,
>(categories: C[]): Array<{ category: string; item: T }> {
  const result: Array<{ category: string; item: T }> = [];
  for (const category of categories) {
    for (const item of category.items) {
      result.push({ category: category.label, item });
    }
  }
  return result;
}
