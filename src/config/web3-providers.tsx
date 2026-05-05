/**
 * @deprecated Replaced by `JoyWalletProviders` in `./joy-wallet-providers.tsx`,
 * which now mounts WagmiProvider + ThirdwebProvider + PrivyProvider once at
 * the app root in `src/renderer.tsx`.
 *
 * This file is kept as a compatibility shim so older imports still resolve.
 * Remove it once all consumers have migrated.
 */

import React from "react";

// Re-export the canonical wagmi config so legacy imports keep working.
export { wagmiConfig } from "./joy-wallet-providers";

/**
 * @deprecated No-op wrapper. The real providers are mounted globally at
 * the app root via `JoyWalletProviders`. This component just renders its
 * children to avoid breaking imports.
 */
export function Web3Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
