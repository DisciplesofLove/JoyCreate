/**
 * JoyWalletProviders — single provider wrapper that mounts at the app
 * root and enables wallet connections across all of JoyCreate.
 *
 * Composes (outer → inner):
 *   - PrivyProvider          (email / social / embedded wallet)
 *   - WagmiProvider          (existing wagmi hooks: useAccount, useSignMessage, ...)
 *   - ThirdwebProvider       (Thirdweb v5 hooks for ERC-1155 minting)
 *   - JoyPrivyBridge         (registers Privy with our wallet connector)
 *   - Initialises the wallet registry (MetaMask, Rainbow, Coinbase,
 *     WalletConnect, JoyWallet) on first mount.
 *
 * Replaces the old `<Web3Providers>` wrapper that was previously mounted
 * per-page on `/create-asset` — keeping it global guarantees a single
 * QueryClient + WagmiConfig instance app-wide.
 *
 * Privy is a no-op when VITE_PRIVY_APP_ID is missing — it still mounts
 * but the Privy login button surfaces a clear error explaining how to
 * set the env var.
 */

import { useEffect, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { ThirdwebProvider } from "thirdweb/react";
import { http, createConfig, WagmiProvider } from "wagmi";
import { polygonAmoy } from "wagmi/chains";
import { JoyPrivyBridge } from "../components/wallet/JoyPrivyBridge";
import { initWalletRegistry } from "../lib/wallet/registry";

const PRIVY_APP_ID =
  (import.meta.env.VITE_PRIVY_APP_ID as string | undefined) ??
  // Stub ID — Privy login will surface a configuration error if used
  // before the integrator sets a real ID. The provider itself is safe
  // to mount with a placeholder.
  "joycreate-set-VITE_PRIVY_APP_ID";

// Single app-wide wagmi config. Thirdweb manages its own provider tree
// internally so we just mount <ThirdwebProvider> without explicit config.
export const wagmiConfig = createConfig({
  chains: [polygonAmoy],
  transports: {
    [polygonAmoy.id]: http(),
  },
});

export function JoyWalletProviders({ children }: { children: ReactNode }) {
  useEffect(() => {
    initWalletRegistry();
  }, []);

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: "light",
          accentColor: "#7c3aed",
          logo: "https://joycreate.io/icon.png",
        },
        loginMethods: ["email", "wallet", "google", "github", "apple"],
        embeddedWallets: {
          createOnLogin: "users-without-wallets",
        },
        defaultChain: { id: 80002, name: "Polygon Amoy" } as never,
      }}
    >
      <WagmiProvider config={wagmiConfig}>
        <ThirdwebProvider>
          <JoyPrivyBridge />
          {children}
        </ThirdwebProvider>
      </WagmiProvider>
    </PrivyProvider>
  );
}

