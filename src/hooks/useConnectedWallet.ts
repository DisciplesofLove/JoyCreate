/**
 * useConnectedWallet — React hook for the unified wallet state.
 *
 * Subscribes to `joy_wallet_connector` and re-renders when the
 * connected wallet changes (account swap, chain swap, disconnect).
 */

import { useEffect, useState, useCallback } from "react";
import {
  connectWallet,
  disconnectWallet,
  getCurrentWallet,
  listWalletAdapters,
  subscribeWallet,
  type ConnectedWallet,
  type WalletProviderId,
  signMessageWithWallet,
  getBalanceEth,
} from "../lib/wallet/joy_wallet_connector";

export function useConnectedWallet() {
  const [wallet, setWallet] = useState<ConnectedWallet | null>(() => getCurrentWallet());

  useEffect(() => {
    return subscribeWallet(setWallet);
  }, []);

  const connect = useCallback((id: WalletProviderId) => connectWallet(id), []);
  const disconnect = useCallback(() => disconnectWallet(), []);
  const sign = useCallback((m: string) => signMessageWithWallet(m), []);
  const balance = useCallback(() => getBalanceEth(), []);

  return {
    wallet,
    isConnected: !!wallet,
    address: wallet?.address ?? null,
    chainId: wallet?.chainId ?? null,
    providerId: wallet?.providerId ?? null,
    adapters: listWalletAdapters(),
    connect,
    disconnect,
    sign,
    balance,
  };
}
