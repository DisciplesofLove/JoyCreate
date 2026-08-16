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
import { polygonAmoy, arbitrumSepolia } from "wagmi/chains";
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

// Single app-wide wagmi config. Both Polygon Amoy and Arbitrum Sepolia are
// registered so users can switch between marketplace chains in Settings →
// Marketplace network without re-mounting the provider tree. Thirdweb manages
// its own provider tree internally so we just mount <ThirdwebProvider>
// without explicit config.
export const wagmiConfig = createConfig({
  chains: [polygonAmoy, arbitrumSepolia],
  transports: {
    [polygonAmoy.id]: http(),
    [arbitrumSepolia.id]: http(),
  },
});

export function JoyWalletProviders({ children }: { children: ReactNode }) {
  useEffect(() => {
    initWalletRegistry();
  }, []);

  // Privy's embedded wallet is only available over HTTPS (localhost is also
  // accepted). Chromium treats file:// as a *secure context* (so
  // `window.isSecureContext` is TRUE there — do NOT use it), but Privy checks
  // the URL protocol and throws "Embedded wallet is only available over HTTPS"
  // during render when it isn't https/localhost — which crashes the whole
  // renderer before it can mount. The packaged desktop app serves the UI over
  // file://, so gate Privy on the actual protocol instead.
  const loc = typeof window !== "undefined" ? window.location : undefined;
  const privyCanRun =
    loc?.protocol === "https:" ||
    (loc?.protocol === "http:" &&
      (loc.hostname === "localhost" || loc.hostname === "127.0.0.1"));

  const inner = (
    <WagmiProvider config={wagmiConfig}>
      <ThirdwebProvider>
        {/* JoyPrivyBridge calls usePrivy(), which requires a mounted
            PrivyProvider — only render it when Privy will actually mount
            (app id set AND https/localhost). */}
        {PRIVY_APP_ID && privyCanRun ? <JoyPrivyBridge /> : null}
        {children}
      </ThirdwebProvider>
    </WagmiProvider>
  );

  if (!PRIVY_APP_ID || !privyCanRun) {
    // Skip the Privy provider entirely when either:
    //   1. No Privy app id is configured, OR
    //   2. The page isn't served over https/localhost (the packaged desktop
    //      build serves the UI over file://). Privy eagerly initializes its
    //      embedded wallet and throws "Embedded wallet is only available over
    //      HTTPS" during render otherwise, crashing the whole renderer before
    //      it can mount. Omitting the `embeddedWallets` config is NOT enough —
    //      the provider must not mount at all.
    // External wallets (MetaMask / WalletConnect via wagmi + thirdweb) still
    // work; only Privy email/social/embedded-wallet login is unavailable in the
    // packaged build. Re-enabling it requires serving the renderer from a
    // custom secure (https) scheme instead of file://.
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

