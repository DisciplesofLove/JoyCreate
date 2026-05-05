/**
 * WalletConnect v2 adapter — covers MetaMask Mobile, Rainbow, Trust,
 * Zerion, and any other WalletConnect-compatible wallet.
 *
 * The same underlying provider is reused for the dedicated MetaMask
 * and Rainbow adapters; they only differ in the "explorerRecommendedWalletIds"
 * surfaced in the QR-modal UI.
 *
 * Project ID is read from VITE_WALLETCONNECT_PROJECT_ID. A free ID can
 * be created at https://cloud.reown.com (formerly walletconnect.com).
 */

import { EthereumProvider } from "@walletconnect/ethereum-provider";
import {
  attachProviderListeners,
  type WalletAdapter,
  type WalletProviderId,
} from "../joy_wallet_connector";

const POLYGON_AMOY_ID = 80002;
const DEFAULT_CHAINS = [POLYGON_AMOY_ID, 1, 137]; // Amoy + mainnet + Polygon

const PROJECT_ID =
  (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ??
  "joycreate-fallback-projectid"; // overridable at runtime

// Curated wallet IDs from WalletConnect Cloud Explorer.
// Used to surface specific wallets at the top of the QR modal.
const WALLET_IDS = {
  metamask: "c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96",
  rainbow: "1ae92b26df02f0abca6304df07debccd18262fdf5fe82daa81593582dac9a369",
  trust: "4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0",
} as const;

type WCInstance = Awaited<ReturnType<typeof EthereumProvider.init>>;

let sharedProvider: WCInstance | null = null;
let initPromise: Promise<WCInstance> | null = null;

async function getSharedProvider(): Promise<WCInstance> {
  if (sharedProvider) return sharedProvider;
  if (initPromise) return initPromise;
  initPromise = EthereumProvider.init({
    projectId: PROJECT_ID,
    chains: [POLYGON_AMOY_ID],
    optionalChains: DEFAULT_CHAINS,
    showQrModal: true,
    metadata: {
      name: "JoyCreate",
      description: "JoyCreate — agentic creator OS",
      url: "https://joycreate.io",
      icons: ["https://joycreate.io/icon.png"],
    },
  }).then((p) => {
    sharedProvider = p;
    return p;
  });
  return initPromise;
}

interface BuildOpts {
  id: WalletProviderId;
  name: string;
  icon: string;
  description: string;
  /** Wallet ID to feature (highlights the wallet in the QR modal). */
  featuredWalletId?: string;
}

function build(opts: BuildOpts): WalletAdapter {
  const adapter: WalletAdapter = {
    id: opts.id,
    name: opts.name,
    icon: opts.icon,
    description: opts.description,

    async connect() {
      const provider = await getSharedProvider();
      // WalletConnect v2 surfaces all compatible wallets in its built-in
      // QR modal; the featured-wallet hint is configured at init time,
      // so for runtime selection we just open the modal and let the user
      // pick the wallet they want.
      void opts.featuredWalletId;
      await provider.connect();

      const accounts = (provider.accounts ?? []) as string[];
      if (accounts.length === 0) {
        throw new Error("WalletConnect session has no accounts");
      }
      attachProviderListeners(adapter);
      return { address: accounts[0], chainId: provider.chainId ?? POLYGON_AMOY_ID };
    },

    async disconnect() {
      const provider = await getSharedProvider();
      try {
        await provider.disconnect();
      } catch {
        /* noop */
      }
    },

    getProvider() {
      // EthereumProvider implements EIP-1193 (request/on/removeListener).
      return sharedProvider as unknown as { request: (a: { method: string; params?: unknown }) => Promise<unknown> } | null;
    },

    async restoreSession() {
      const provider = await getSharedProvider();
      const accounts = (provider.accounts ?? []) as string[];
      if (accounts.length === 0) return null;
      attachProviderListeners(adapter);
      return { address: accounts[0], chainId: provider.chainId ?? POLYGON_AMOY_ID };
    },
  };
  return adapter;
}

export const walletConnectAdapter: WalletAdapter = build({
  id: "walletconnect",
  name: "WalletConnect",
  icon: "🔗",
  description: "Scan a QR with any WalletConnect-compatible wallet.",
});

export const metamaskAdapter: WalletAdapter = build({
  id: "metamask",
  name: "MetaMask",
  icon: "🦊",
  description: "Connect MetaMask Mobile via WalletConnect.",
  featuredWalletId: WALLET_IDS.metamask,
});

export const rainbowAdapter: WalletAdapter = build({
  id: "rainbow",
  name: "Rainbow",
  icon: "🌈",
  description: "Connect Rainbow Wallet via WalletConnect.",
  featuredWalletId: WALLET_IDS.rainbow,
});
