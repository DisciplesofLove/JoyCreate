/**
 * Joy Wallet Connector — unified wallet abstraction for JoyCreate.
 *
 * Sits BELOW the React layer so any code (browser, marketplace, asset
 * wizard, agents) can talk to whatever wallet the user has connected
 * without caring whether it's WalletConnect, Coinbase, Privy, MetaMask
 * (via WC), or the built-in JoyWallet.
 *
 * Every adapter exposes the same minimal contract:
 *   - getProvider(): EIP-1193-compatible
 *   - connect(): returns address(es) + chain id
 *   - disconnect(): tears down session
 *
 * The connected adapter is persisted (LS) so reloads resume the session
 * automatically.
 */

import {
  BrowserProvider,
  type Eip1193Provider,
  formatEther,
  type JsonRpcSigner,
} from "ethers";

export type WalletProviderId =
  | "joywallet"
  | "walletconnect"
  | "metamask"
  | "rainbow"
  | "coinbase"
  | "privy";

export interface WalletAdapter {
  id: WalletProviderId;
  /** Display name. */
  name: string;
  /** Inline SVG/emoji icon. */
  icon: string;
  /** Brief one-line description. */
  description: string;
  /**
   * Initiate connection. Returns the canonical address.
   *
   * Adapters that need user interaction (QR scan, popup) should resolve
   * only after the user has confirmed; reject if the user cancels.
   */
  connect(): Promise<{ address: string; chainId: number }>;
  disconnect(): Promise<void>;
  /** EIP-1193-compatible provider for ethers.BrowserProvider. */
  getProvider(): Eip1193Provider | null;
  /** Resume an existing session if any. */
  restoreSession?(): Promise<{ address: string; chainId: number } | null>;
}

export interface ConnectedWallet {
  providerId: WalletProviderId;
  address: string;
  chainId: number;
  /** Adapter instance (for raw EIP-1193 access). */
  adapter: WalletAdapter;
}

const LS_LAST = "joywallet:lastConnector";

const subscribers = new Set<(w: ConnectedWallet | null) => void>();
let current: ConnectedWallet | null = null;
const adapters = new Map<WalletProviderId, WalletAdapter>();

// ── Registry API ────────────────────────────────────────────────────────────

export function registerWalletAdapter(adapter: WalletAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function listWalletAdapters(): WalletAdapter[] {
  return Array.from(adapters.values());
}

export function getCurrentWallet(): ConnectedWallet | null {
  return current;
}

export function subscribeWallet(fn: (w: ConnectedWallet | null) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit(): void {
  for (const fn of subscribers) fn(current);
}

// ── Connection lifecycle ────────────────────────────────────────────────────

export async function connectWallet(id: WalletProviderId): Promise<ConnectedWallet> {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Wallet adapter not registered: ${id}`);

  // Tear down existing session before switching.
  if (current && current.providerId !== id) await disconnectWallet();

  const { address, chainId } = await adapter.connect();
  current = { providerId: id, address, chainId, adapter };
  try {
    localStorage.setItem(LS_LAST, id);
  } catch {
    /* noop */
  }
  emit();
  return current;
}

export async function disconnectWallet(): Promise<void> {
  if (!current) return;
  try {
    await current.adapter.disconnect();
  } catch (err) {
    console.warn("Wallet disconnect error", err);
  }
  current = null;
  try {
    localStorage.removeItem(LS_LAST);
  } catch {
    /* noop */
  }
  emit();
}

/**
 * Try to restore the previously-active wallet on app load. No throw —
 * just resolves to null on failure so the user is shown the picker.
 */
export async function restoreLastWallet(): Promise<ConnectedWallet | null> {
  let lastId: string | null = null;
  try {
    lastId = localStorage.getItem(LS_LAST);
  } catch {
    /* noop */
  }
  if (!lastId) return null;
  const adapter = adapters.get(lastId as WalletProviderId);
  if (!adapter?.restoreSession) return null;
  try {
    const session = await adapter.restoreSession();
    if (!session) return null;
    current = { providerId: adapter.id, address: session.address, chainId: session.chainId, adapter };
    emit();
    return current;
  } catch (err) {
    console.warn("Failed to restore wallet session", err);
    return null;
  }
}

// ── Convenience: ethers helpers built on top of whichever wallet is live ────

export function getEthersProvider(): BrowserProvider | null {
  if (!current) return null;
  const eip = current.adapter.getProvider();
  if (!eip) return null;
  return new BrowserProvider(eip, "any");
}

export async function getEthersSigner(): Promise<JsonRpcSigner | null> {
  const provider = getEthersProvider();
  if (!provider) return null;
  return provider.getSigner();
}

export async function getBalanceEth(): Promise<string | null> {
  if (!current) return null;
  const provider = getEthersProvider();
  if (!provider) return null;
  const wei = await provider.getBalance(current.address);
  return formatEther(wei);
}

export async function signMessageWithWallet(message: string): Promise<string> {
  const signer = await getEthersSigner();
  if (!signer) throw new Error("No wallet connected");
  return signer.signMessage(message);
}

/**
 * Watch chain / account changes from the underlying EIP-1193 provider
 * and update the unified state. Adapters can call this from inside
 * their connect() once they have a provider.
 */
export function attachProviderListeners(adapter: WalletAdapter): void {
  const eip = adapter.getProvider() as
    | (Eip1193Provider & { on?: (e: string, h: (...args: unknown[]) => void) => void })
    | null;
  if (!eip?.on) return;

  eip.on("accountsChanged", (...args: unknown[]) => {
    const accs = args[0] as string[] | undefined;
    if (!current || current.providerId !== adapter.id) return;
    if (!accs || accs.length === 0) {
      void disconnectWallet();
      return;
    }
    current = { ...current, address: accs[0] };
    emit();
  });

  eip.on("chainChanged", (...args: unknown[]) => {
    const cid = args[0] as string | number;
    if (!current || current.providerId !== adapter.id) return;
    const chainId = typeof cid === "string" ? parseInt(cid, 16) : cid;
    current = { ...current, chainId };
    emit();
  });

  eip.on("disconnect", () => {
    if (current?.providerId === adapter.id) void disconnectWallet();
  });
}
