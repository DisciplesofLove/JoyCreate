/**
 * WalletPicker — unified UI for connecting one of the supported
 * wallets (MetaMask, Rainbow, Coinbase, Privy, JoyWallet, generic
 * WalletConnect). Drop into any panel that needs a wallet connection.
 */

import { useState } from "react";
import { Button } from "../ui/button";
import { Loader2, LogOut, Copy, Check } from "lucide-react";
import { useConnectedWallet } from "../../hooks/useConnectedWallet";
import type { WalletProviderId } from "../../lib/wallet/joy_wallet_connector";

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

interface Props {
  /** Compact: no description, smaller buttons. */
  compact?: boolean;
  /** Hide the JoyWallet built-in option. */
  excludeBuiltIn?: boolean;
}

export function WalletPicker({ compact = false, excludeBuiltIn = false }: Props) {
  const { wallet, adapters, connect, disconnect } = useConnectedWallet();
  const [busy, setBusy] = useState<WalletProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleConnect(id: WalletProviderId) {
    setError(null);
    setBusy(id);
    try {
      await connect(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy() {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  }

  if (wallet) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-emerald-300/40 bg-emerald-50/60 p-3 dark:bg-emerald-950/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{wallet.adapter.icon}</span>
              <div>
                <div className="text-sm font-semibold">{wallet.adapter.name}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {shortAddr(wallet.address)} · chain {wallet.chainId}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" onClick={handleCopy} title="Copy address">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button size="icon" variant="ghost" onClick={() => void disconnect()} title="Disconnect">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const visible = excludeBuiltIn ? adapters.filter((a) => a.id !== "joywallet") : adapters;

  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-xs text-muted-foreground">
          Connect a wallet to sign transactions, claim earnings, and access
          on-chain features across JoyCreate.
        </p>
      )}
      <div className="grid gap-2">
        {visible.map((a) => (
          <Button
            key={a.id}
            variant="outline"
            className="h-auto justify-start gap-3 py-2.5"
            disabled={busy !== null}
            onClick={() => void handleConnect(a.id)}
          >
            <span className="text-xl">{a.icon}</span>
            <span className="flex-1 text-left">
              <span className="block text-sm font-medium">{a.name}</span>
              {!compact && (
                <span className="block text-xs font-normal text-muted-foreground">
                  {a.description}
                </span>
              )}
            </span>
            {busy === a.id && <Loader2 className="h-4 w-4 animate-spin" />}
          </Button>
        ))}
      </div>
      {error && (
        <div className="rounded-md border border-rose-300/50 bg-rose-50/60 p-2 text-xs text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}
