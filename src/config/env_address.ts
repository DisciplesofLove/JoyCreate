/**
 * LR7 — env-provided contract address override.
 *
 * Lets the Arbitrum One mainnet addresses be supplied by configuration after
 * deploy, with no code change (a config-only cutover). Reads from the Vite
 * renderer env (`import.meta.env`, `VITE_`-prefixed) first, then the Electron
 * main process env (`process.env`), and finally falls back to `fallback`
 * (typically `ZERO_ADDRESS`, which keeps the chain's readiness predicate false
 * until a real address is provided).
 *
 * Deliberately dependency-free so it is safe to import from both the main and
 * renderer bundles (mirrors the guard in `subgraphs.ts`).
 */

const viteEnv = (typeof import.meta !== "undefined" ? import.meta.env : undefined) as
  | Record<string, string | undefined>
  | undefined;

export function envAddress(key: string, fallback: string): string {
  const fromVite = viteEnv?.[key];
  if (fromVite && fromVite.length > 0) return fromVite;
  const proc = typeof process !== "undefined" ? process.env : undefined;
  const fromProc = proc?.[key];
  if (fromProc && fromProc.length > 0) return fromProc;
  return fallback;
}
