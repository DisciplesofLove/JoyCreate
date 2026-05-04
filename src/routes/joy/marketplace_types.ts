/**
 * Marketplace asset-type constants — extracted from `marketplace.ts` so that
 * the page component (`@/pages/joy/MarketplacePage`) can import the type
 * list without participating in the circular import that triggered
 *   "Cannot access 'MARKETPLACE_TYPES' before initialization"
 * at renderer boot. The route file also re-exports these for back-compat.
 */

export const MARKETPLACE_TYPES = [
  "agent",
  "workflow",
  "app",
  "model",
  "dataset",
  "template",
  "component",
  "plugin",
] as const;

export type MarketplaceType = (typeof MARKETPLACE_TYPES)[number];
