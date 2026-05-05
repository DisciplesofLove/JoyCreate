/**
 * Privy adapter — embedded wallets + email/social login.
 *
 * Privy ships as a React-only SDK (`@privy-io/react-auth`). It needs
 * a `<PrivyProvider>` at the root and exposes hooks (`usePrivy`,
 * `useWallets`). Because our connector lives outside React, this
 * adapter cannot drive Privy directly — instead it depends on a
 * runtime "controller" that the React layer registers on mount.
 *
 * The controller bridge keeps the connector framework-agnostic while
 * letting Privy work with its required React lifecycle.
 */

import {
  attachProviderListeners,
  type WalletAdapter,
} from "../joy_wallet_connector";

export interface PrivyController {
  /** Open Privy login modal; resolves with active EOA address. */
  login(): Promise<{ address: string; chainId: number }>;
  /** Log out and revoke session. */
  logout(): Promise<void>;
  /** Get the EIP-1193 provider for the current Privy wallet. */
  getProvider(): {
    request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  } | null;
  /** Currently-authenticated address, if any. */
  currentAddress(): string | null;
  /** Active chain id (from active wallet), if any. */
  currentChainId(): number | null;
}

let controller: PrivyController | null = null;

export function setPrivyController(c: PrivyController | null): void {
  controller = c;
}

export const privyAdapter: WalletAdapter = {
  id: "privy",
  name: "Privy",
  icon: "✨",
  description: "Email / social login with embedded smart wallet.",

  async connect() {
    if (!controller) {
      throw new Error(
        "Privy not initialised. Make sure <JoyPrivyBridge /> is mounted at the app root.",
      );
    }
    const result = await controller.login();
    attachProviderListeners(privyAdapter);
    return result;
  },

  async disconnect() {
    if (!controller) return;
    try {
      await controller.logout();
    } catch {
      /* noop */
    }
  },

  getProvider() {
    return controller?.getProvider() ?? null;
  },

  async restoreSession() {
    if (!controller) return null;
    const address = controller.currentAddress();
    if (!address) return null;
    const chainId = controller.currentChainId() ?? 80002;
    attachProviderListeners(privyAdapter);
    return { address, chainId };
  },
};
