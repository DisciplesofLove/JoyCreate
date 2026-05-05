/**
 * JoyPrivyBridge — wires the Privy React SDK into our framework-agnostic
 * wallet connector. Mount once at the app root, INSIDE <PrivyProvider>.
 *
 * Without this bridge, the Privy adapter throws on `connect()`.
 */

import { useEffect, useMemo } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { setPrivyController, type PrivyController } from "../../lib/wallet/adapters/privy_adapter";

export function JoyPrivyBridge() {
  const { login, logout, authenticated, ready } = usePrivy();
  const { wallets } = useWallets();

  const controller = useMemo<PrivyController>(() => {
    return {
      async login() {
        await login();
        // Wait briefly for the wallets array to populate.
        for (let i = 0; i < 30; i++) {
          if (wallets.length > 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const w = wallets[0];
        if (!w) throw new Error("Privy login returned no wallet");
        const provider = await w.getEthereumProvider();
        const cidHex = (await provider.request({ method: "eth_chainId" })) as string;
        return { address: w.address, chainId: parseInt(cidHex, 16) };
      },
      async logout() {
        await logout();
      },
      getProvider() {
        const w = wallets[0];
        if (!w) return null;
        // getEthereumProvider is async — best-effort sync return is null.
        // The connector's getEthersProvider() handles the null case.
        // For sync usage, we cache the latest provider via effect below.
        return latestProvider;
      },
      currentAddress() {
        if (!authenticated || wallets.length === 0) return null;
        return wallets[0].address;
      },
      currentChainId() {
        if (!authenticated || wallets.length === 0) return null;
        const cid = wallets[0].chainId; // e.g. "eip155:80002"
        if (typeof cid === "string") {
          const tail = cid.split(":").pop();
          return tail ? parseInt(tail, 10) : null;
        }
        return null;
      },
    };
  }, [login, logout, authenticated, wallets]);

  useEffect(() => {
    if (!ready) return;
    setPrivyController(controller);
    return () => setPrivyController(null);
  }, [ready, controller]);

  // Cache the latest EIP-1193 provider for sync access.
  useEffect(() => {
    if (!wallets[0]) {
      latestProvider = null;
      return;
    }
    let cancelled = false;
    void wallets[0].getEthereumProvider().then((p) => {
      if (!cancelled) latestProvider = p as typeof latestProvider;
    });
    return () => {
      cancelled = true;
    };
  }, [wallets]);

  return null;
}

let latestProvider:
  | { request: (args: { method: string; params?: unknown }) => Promise<unknown> }
  | null = null;
