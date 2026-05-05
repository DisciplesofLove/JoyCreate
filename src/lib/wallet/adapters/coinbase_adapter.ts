/**
 * Coinbase Wallet adapter — uses Coinbase Wallet SDK in
 * "smartWalletOnly" preference. Works with the Coinbase mobile app
 * (QR / deep link) AND the new Smart Wallet (no extension required).
 */

import { CoinbaseWalletSDK } from "@coinbase/wallet-sdk";
import {
  attachProviderListeners,
  type WalletAdapter,
} from "../joy_wallet_connector";

const POLYGON_AMOY_ID = 80002;
const POLYGON_AMOY_RPC = "https://rpc-amoy.polygon.technology";

type CbProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  disconnect?: () => Promise<void> | void;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
};

let sdk: CoinbaseWalletSDK | null = null;
let provider: CbProvider | null = null;

function getProviderInstance(): CbProvider {
  if (provider) return provider;
  if (!sdk) {
    sdk = new CoinbaseWalletSDK({
      appName: "JoyCreate",
      appLogoUrl: "https://joycreate.io/icon.png",
      appChainIds: [POLYGON_AMOY_ID, 1, 137],
    });
  }
  // makeWeb3Provider returns the EIP-1193 provider.
  // The SDK supports preference: "smartWalletOnly" | "eoaOnly" | "all".
  provider = sdk.makeWeb3Provider({
    options: "all",
  } as unknown as Parameters<CoinbaseWalletSDK["makeWeb3Provider"]>[0]) as CbProvider;
  return provider;
}

export const coinbaseAdapter: WalletAdapter = {
  id: "coinbase",
  name: "Coinbase Wallet",
  icon: "🪙",
  description: "Connect Coinbase Wallet (extension, mobile, or smart wallet).",

  async connect() {
    const eip = getProviderInstance();
    const accounts = (await eip.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts || accounts.length === 0) {
      throw new Error("Coinbase Wallet returned no accounts");
    }
    let chainId = POLYGON_AMOY_ID;
    try {
      const cidHex = (await eip.request({ method: "eth_chainId" })) as string;
      chainId = parseInt(cidHex, 16);
    } catch {
      /* keep default */
    }
    attachProviderListeners(coinbaseAdapter);
    return { address: accounts[0], chainId };
  },

  async disconnect() {
    if (provider?.disconnect) {
      try {
        await provider.disconnect();
      } catch {
        /* noop */
      }
    }
    provider = null;
  },

  getProvider() {
    return (provider as unknown as { request: (a: { method: string; params?: unknown }) => Promise<unknown> }) ?? null;
  },

  async restoreSession() {
    if (!provider) return null;
    try {
      const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
      if (!accounts || accounts.length === 0) return null;
      const cidHex = (await provider.request({ method: "eth_chainId" })) as string;
      attachProviderListeners(coinbaseAdapter);
      return { address: accounts[0], chainId: parseInt(cidHex, 16) };
    } catch {
      return null;
    }
  },
};

// Silence unused-rpc warning.
void POLYGON_AMOY_RPC;
