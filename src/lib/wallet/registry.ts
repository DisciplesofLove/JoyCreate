/**
 * Wallet registry — register all adapters in one place. Import this
 * module once (e.g. in `main.tsx`) before any wallet UI is rendered.
 */

import {
  registerWalletAdapter,
  restoreLastWallet,
} from "./joy_wallet_connector";
import { joyWalletAdapter } from "./adapters/joy_wallet_adapter";
import {
  walletConnectAdapter,
  metamaskAdapter,
  rainbowAdapter,
} from "./adapters/walletconnect_adapter";
import { coinbaseAdapter } from "./adapters/coinbase_adapter";
import { privyAdapter } from "./adapters/privy_adapter";

let initialised = false;

export function initWalletRegistry(): void {
  if (initialised) return;
  initialised = true;
  registerWalletAdapter(joyWalletAdapter);
  registerWalletAdapter(metamaskAdapter);
  registerWalletAdapter(rainbowAdapter);
  registerWalletAdapter(walletConnectAdapter);
  registerWalletAdapter(coinbaseAdapter);
  registerWalletAdapter(privyAdapter);
  // Best-effort silent restore.
  void restoreLastWallet();
}
