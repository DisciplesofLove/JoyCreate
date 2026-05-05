/**
 * JoyWalletProviders — single provider wrapper that mounts at the app
 * root and enables wallet connections across all of JoyCreate.
 *
 * Composes:
 *   - PrivyProvider (email / social / embedded wallet)
 *   - JoyPrivyBridge (registers Privy with our wallet connector)
 *   - Initialises the wallet registry (MetaMask, Rainbow, Coinbase,
 *     WalletConnect, JoyWallet) on first mount.
 *
 * Privy is a no-op when VITE_PRIVY_APP_ID is missing — it still mounts
 * but the Privy login button will throw a clear error explaining how
 * to set the env var.
 */

import { useEffect, type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { JoyPrivyBridge } from "../components/wallet/JoyPrivyBridge";
import { initWalletRegistry } from "../lib/wallet/registry";

const PRIVY_APP_ID =
  (import.meta.env.VITE_PRIVY_APP_ID as string | undefined) ??
  // Stub ID — Privy login will surface a configuration error if used
  // before the integrator sets a real ID. The provider itself is safe
  // to mount with a placeholder.
  "joycreate-set-VITE_PRIVY_APP_ID";

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
      <JoyPrivyBridge />
      {children}
    </PrivyProvider>
  );
}
