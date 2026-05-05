/**
 * JoyWallet adapter — wraps the built-in self-custodial wallet
 * (`src/lib/joy_wallet.ts`) so it conforms to the unified WalletAdapter
 * contract.
 *
 * This adapter is a no-network shim: it does not implement EIP-1193
 * `request` since on-chain calls are routed through the JoyWallet's
 * own ethers provider. Components that need EIP-1193 access should
 * fall back to the connector layer in `joy_wallet.ts` directly.
 */

import {
  getStoredAddress,
  getStoredInfo,
  type JoyWalletInfo,
} from "../../joy_wallet";
import type { WalletAdapter } from "./joy_wallet_connector";

const DEFAULT_CHAIN_ID = 80002; // Polygon Amoy

export const joyWalletAdapter: WalletAdapter = {
  id: "joywallet",
  name: "JoyWallet",
  icon: "🪪",
  description: "Built-in self-custodial wallet (no extension required).",

  async connect() {
    const info: JoyWalletInfo | null = getStoredInfo();
    if (!info) {
      throw new Error(
        "No JoyWallet found. Create or import one from the Wallet panel first.",
      );
    }
    return { address: info.address, chainId: DEFAULT_CHAIN_ID };
  },

  async disconnect() {
    // Built-in wallet is always present; "disconnect" is a no-op.
  },

  getProvider() {
    // The built-in wallet does not expose EIP-1193; downstream code
    // should call into `joy_wallet.ts` for sign / send operations.
    return null;
  },

  async restoreSession() {
    const address = getStoredAddress();
    if (!address) return null;
    return { address, chainId: DEFAULT_CHAIN_ID };
  },
};
