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

const RAW_PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as
  | string
  | undefined)?.trim();

// Privy refuses to load its iframe and floods the console with
// "Exceeded max attempts before resolving function" when the appId is a
// placeholder. That repeated failure can starve the React tree on slow
// machines and surface as a white screen. Treat any non-real-looking ID
// as "Privy disabled" and skip the provider entirely.
const PRIVY_APP_ID =
  RAW_PRIVY_APP_ID && RAW_PRIVY_APP_ID.length > 0 &&
  !RAW_PRIVY_APP_ID.startsWith("joycreate-set-")
    ? RAW_PRIVY_APP_ID
    : null;

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

  const inner = (
    <WagmiProvider config={wagmiConfig}>
      <ThirdwebProvider>
        {PRIVY_APP_ID ? <JoyPrivyBridge /> : null}
        {children}
      </ThirdwebProvider>
    </WagmiProvider>
  );

  if (!PRIVY_APP_ID) {
    // No Privy app id configured — skip the provider so the app still
    // boots. Privy-dependent UIs surface a clear "set VITE_PRIVY_APP_ID"
    // message instead of bringing the whole window down with a white
    // screen.
    return inner;
  }

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
      {inner}
    </PrivyProvider>
  );
}

