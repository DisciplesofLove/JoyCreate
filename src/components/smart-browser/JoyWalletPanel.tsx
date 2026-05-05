/**
 * JoyWalletPanel — built-in self-custodial wallet UI for the Smart Browser.
 *
 * - Create or import a wallet (private-key kept locally, AES-GCM encrypted)
 * - Show address + Polygon Amoy balance
 * - Sign messages, send native tokens, export key, delete wallet
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Wallet as WalletIcon,
  Copy,
  RefreshCw,
  LogOut,
  KeyRound,
  Send,
  Pen,
  Plus,
  Download,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import {
  createWallet,
  deleteWallet,
  exportPrivateKey,
  getBalance,
  getStoredInfo,
  importWallet,
  sendNative,
  signMessage,
  type JoyWalletInfo,
} from "@/lib/joy_wallet";
import { WalletPicker } from "@/components/wallet/WalletPicker";

type Mode = "view" | "create" | "import" | "send" | "sign";

export function JoyWalletPanel() {
  const [info, setInfo] = useState<JoyWalletInfo | null>(() => getStoredInfo());
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceErr, setBalanceErr] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Create form
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");

  // Import form
  const [importPk, setImportPk] = useState("");

  // Send form
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [sendPw, setSendPw] = useState("");

  // Sign form
  const [signMsg, setSignMsg] = useState("");
  const [signPw, setSignPw] = useState("");
  const [signature, setSignature] = useState<string | null>(null);

  // Export form
  const [exportPw, setExportPw] = useState("");
  const [exportedKey, setExportedKey] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    if (!info) return;
    setLoadingBalance(true);
    setBalanceErr(null);
    try {
      const b = await getBalance();
      setBalance(b.eth);
    } catch (e: any) {
      setBalanceErr(e?.message ?? "Failed to fetch balance");
      setBalance(null);
    } finally {
      setLoadingBalance(false);
    }
  }, [info]);

  useEffect(() => {
    if (info) void loadBalance();
  }, [info, loadBalance]);

  const reset = () => {
    setErr(null);
    setOkMsg(null);
    setPw1("");
    setPw2("");
    setImportPk("");
    setSendTo("");
    setSendAmt("");
    setSendPw("");
    setSignMsg("");
    setSignPw("");
    setSignature(null);
    setExportPw("");
    setExportedKey(null);
  };

  const handleCreate = async () => {
    setErr(null);
    if (pw1 && pw1 !== pw2) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const w = await createWallet(pw1 || undefined);
      setInfo(w);
      setMode("view");
      reset();
      setOkMsg("Wallet created. Back up your private key from Settings.");
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create wallet");
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    setErr(null);
    setBusy(true);
    try {
      const w = await importWallet(importPk.trim(), pw1 || undefined);
      setInfo(w);
      setMode("view");
      reset();
      setOkMsg("Wallet imported.");
    } catch (e: any) {
      setErr(e?.message ?? "Failed to import wallet");
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async () => {
    setErr(null);
    setBusy(true);
    try {
      const hash = await sendNative(sendTo.trim(), sendAmt.trim(), sendPw || undefined);
      setOkMsg(`Sent. Tx: ${hash}`);
      setMode("view");
      reset();
      void loadBalance();
    } catch (e: any) {
      setErr(e?.message ?? "Send failed");
    } finally {
      setBusy(false);
    }
  };

  const handleSign = async () => {
    setErr(null);
    setBusy(true);
    try {
      const sig = await signMessage(signMsg, signPw || undefined);
      setSignature(sig);
    } catch (e: any) {
      setErr(e?.message ?? "Sign failed");
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async () => {
    setErr(null);
    setBusy(true);
    try {
      const pk = await exportPrivateKey(exportPw || undefined);
      setExportedKey(pk);
    } catch (e: any) {
      setErr(e?.message ?? "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = () => {
    if (!confirm("Delete the local wallet? Make sure you've backed up the private key.")) return;
    deleteWallet();
    setInfo(null);
    setBalance(null);
    setMode("view");
    reset();
  };

  // ── render ────────────────────────────────────────────────────────────────

  if (!info) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2">
          <WalletIcon className="h-4 w-4 text-amber-500" />
          <span className="font-semibold text-sm">JoyWallet</span>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <p className="text-xs text-muted-foreground">
            Self-custodial wallet built into the browser. Your private key is
            stored locally, encrypted, and never leaves this device.
          </p>

          <div className="rounded-md border border-border/50 p-3 space-y-2">
            <div className="text-xs font-semibold">Connect external wallet</div>
            <WalletPicker compact excludeBuiltIn />
          </div>

          <div className="flex items-center gap-2 my-1">
            <div className="flex-1 h-px bg-border/60" />
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              or use built-in
            </span>
            <div className="flex-1 h-px bg-border/60" />
          </div>

          {mode === "view" && (
            <div className="space-y-2">
              <Button className="w-full gap-2" onClick={() => { reset(); setMode("create"); }}>
                <Plus className="h-3.5 w-3.5" /> Create new wallet
              </Button>
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => { reset(); setMode("import"); }}
              >
                <KeyRound className="h-3.5 w-3.5" /> Import private key
              </Button>
            </div>
          )}
          {mode === "create" && (
            <div className="space-y-2 border border-border/50 rounded-md p-3">
              <p className="text-xs">Optional password (encrypts the key at rest).</p>
              <Input
                type="password"
                placeholder="Password (optional)"
                value={pw1}
                onChange={(e) => setPw1(e.target.value)}
              />
              <Input
                type="password"
                placeholder="Confirm password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={handleCreate}>
                  {busy ? "Creating…" : "Create"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Cancel</Button>
              </div>
            </div>
          )}
          {mode === "import" && (
            <div className="space-y-2 border border-border/50 rounded-md p-3">
              <Input
                placeholder="Private key (0x…)"
                value={importPk}
                onChange={(e) => setImportPk(e.target.value)}
                spellCheck={false}
              />
              <Input
                type="password"
                placeholder="Password (optional)"
                value={pw1}
                onChange={(e) => setPw1(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy || !importPk.trim()} onClick={handleImport}>
                  {busy ? "Importing…" : "Import"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Cancel</Button>
              </div>
            </div>
          )}
          {err && <ErrorBox text={err} />}
          {okMsg && <OkBox text={okMsg} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2">
        <WalletIcon className="h-4 w-4 text-amber-500" />
        <span className="font-semibold text-sm">JoyWallet</span>
        {info.encrypted ? (
          <span className="ml-auto text-[10px] flex items-center gap-1 text-emerald-500">
            <ShieldCheck className="h-3 w-3" /> password
          </span>
        ) : (
          <span className="ml-auto text-[10px] flex items-center gap-1 text-amber-500">
            <AlertTriangle className="h-3 w-3" /> no password
          </span>
        )}
      </div>

      <div className="p-3 space-y-3 overflow-y-auto">
        {/* External wallet picker */}
        <div className="rounded-md border border-border/50 p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            External wallet
          </div>
          <WalletPicker compact excludeBuiltIn />
        </div>

        {/* Address card */}
        <div className="rounded-md border border-border/50 bg-muted/30 p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Address</div>
          <div className="font-mono text-xs break-all">{info.address}</div>
          <div className="flex items-center gap-2 text-xs">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 gap-1"
              onClick={() => navigator.clipboard.writeText(info.address)}
            >
              <Copy className="h-3 w-3" /> Copy
            </Button>
          </div>
        </div>

        {/* Balance */}
        <div className="rounded-md border border-border/50 p-3 space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Balance · Polygon Amoy
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={loadBalance}
              disabled={loadingBalance}
              title="Refresh balance"
            >
              <RefreshCw className={`h-3 w-3 ${loadingBalance ? "animate-spin" : ""}`} />
            </Button>
          </div>
          <div className="text-lg font-semibold">
            {balance !== null ? `${parseFloat(balance).toFixed(4)} POL` : balanceErr ? "—" : "…"}
          </div>
          {balanceErr && <p className="text-[10px] text-amber-500">{balanceErr}</p>}
        </div>

        {/* Actions */}
        {mode === "view" && (
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { reset(); setMode("send"); }}>
              <Send className="h-3 w-3" /> Send
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { reset(); setMode("sign"); }}>
              <Pen className="h-3 w-3" /> Sign
            </Button>
          </div>
        )}

        {mode === "send" && (
          <div className="border border-border/50 rounded-md p-3 space-y-2">
            <div className="text-xs font-medium">Send POL</div>
            <Input placeholder="To 0x…" value={sendTo} onChange={(e) => setSendTo(e.target.value)} spellCheck={false} />
            <Input placeholder="Amount" inputMode="decimal" value={sendAmt} onChange={(e) => setSendAmt(e.target.value)} />
            {info.encrypted && (
              <Input type="password" placeholder="Password" value={sendPw} onChange={(e) => setSendPw(e.target.value)} />
            )}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || !sendTo || !sendAmt} onClick={handleSend}>
                {busy ? "Sending…" : "Send"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Cancel</Button>
            </div>
          </div>
        )}

        {mode === "sign" && (
          <div className="border border-border/50 rounded-md p-3 space-y-2">
            <div className="text-xs font-medium">Sign message</div>
            <Input placeholder="Message" value={signMsg} onChange={(e) => setSignMsg(e.target.value)} />
            {info.encrypted && (
              <Input type="password" placeholder="Password" value={signPw} onChange={(e) => setSignPw(e.target.value)} />
            )}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || !signMsg} onClick={handleSign}>
                {busy ? "Signing…" : "Sign"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Cancel</Button>
            </div>
            {signature && (
              <div className="text-[10px] font-mono break-all bg-muted/50 p-2 rounded border border-border/50">
                {signature}
              </div>
            )}
          </div>
        )}

        {/* Settings — export / delete */}
        <details className="border border-border/50 rounded-md p-3 group">
          <summary className="text-xs font-medium cursor-pointer flex items-center gap-1.5 text-muted-foreground">
            <KeyRound className="h-3 w-3" /> Settings & backup
          </summary>
          <div className="mt-2 space-y-2">
            {info.encrypted && (
              <Input
                type="password"
                placeholder="Password"
                value={exportPw}
                onChange={(e) => setExportPw(e.target.value)}
              />
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={handleExport} disabled={busy}>
                <Download className="h-3 w-3" /> Export private key
              </Button>
              <Button size="sm" variant="destructive" className="gap-1.5 ml-auto" onClick={handleDelete}>
                <LogOut className="h-3 w-3" /> Delete
              </Button>
            </div>
            {exportedKey && (
              <div className="text-[10px] font-mono break-all bg-amber-500/10 text-amber-700 dark:text-amber-400 p-2 rounded border border-amber-500/30">
                <div className="text-amber-600 dark:text-amber-300 mb-1 font-sans">
                  Save this somewhere safe. Anyone with this key can drain the wallet.
                </div>
                {exportedKey}
              </div>
            )}
          </div>
        </details>

        {err && <ErrorBox text={err} />}
        {okMsg && <OkBox text={okMsg} />}
      </div>
    </div>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="text-xs text-red-600 dark:text-red-400 border border-red-500/30 bg-red-500/10 rounded px-2 py-1.5">
      {text}
    </div>
  );
}
function OkBox({ text }: { text: string }) {
  return (
    <div className="text-xs text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 bg-emerald-500/10 rounded px-2 py-1.5 break-all">
      {text}
    </div>
  );
}
