/**
 * Smart Browser — multi-tab AI-augmented in-app web browser.
 *
 * Renders an Edge/Chrome-style tab strip plus one Electron <webview>
 * per tab. All webviews share a persistent partition
 * ("persist:joybrowser") so cookies, localStorage and IndexedDB are
 * user-owned and survive app restarts.
 *
 * Side panel hosts: Joy AI · JoyWallet · Privacy & Data.
 *
 * Requires `webviewTag: true` in main BrowserWindow webPreferences.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  X,
  Globe,
  Home,
  Lock,
  Unlock,
  ExternalLink,
  Sparkles,
  PanelRightOpen,
  PanelRightClose,
  Wallet as WalletIcon,
  Shield,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

import { BrowserAiPanel, type PageSnapshot } from "@/components/smart-browser/BrowserAiPanel";
import { JoyWalletPanel } from "@/components/smart-browser/JoyWalletPanel";
import { PrivacyPanel } from "@/components/smart-browser/PrivacyPanel";
import { BrowserTabBar } from "@/components/smart-browser/BrowserTabBar";
import { BrowserWebview } from "@/components/smart-browser/BrowserWebview";

import { useBrowserTabs } from "@/hooks/useBrowserTabs";
import { getStoredAddress } from "@/lib/joy_wallet";

const PARTITION = "persist:joybrowser";

type SidePanelTab = "ai" | "wallet" | "privacy";

// ── Bookmarks ──────────────────────────────────────────────────────────────

const DEFAULT_BOOKMARKS = [
  { label: "JoyCreate", url: "https://joycreate.io" },
  { label: "OpenClaw Docs", url: "https://docs.openclaw.ai" },
  { label: "Ollama", url: "http://localhost:11434" },
  { label: "n8n", url: "http://localhost:5678" },
  { label: "Goldsky", url: "https://goldsky.com" },
  { label: "Hugging Face", url: "https://huggingface.co" },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("about:")) return trimmed;
  if (/^(localhost|127\.|192\.168\.|10\.)/i.test(trimmed)) return `http://${trimmed}`;
  if (/\.[a-z]{2,}/i.test(trimmed) && !trimmed.includes(" ")) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SmartBrowserPage() {
  const {
    tabs,
    activeId,
    activeTab,
    setActiveId,
    openTab,
    closeTab,
    closeOthers,
    reorderTab,
    togglePinned,
    duplicateTab,
    updateTab,
    registerWebview,
    getWebview,
  } = useBrowserTabs();

  const [showSidePanel, setShowSidePanel] = useState(true);
  const [sideTab, setSideTab] = useState<SidePanelTab>("ai");
  const [walletAddress, setWalletAddress] = useState<string | null>(() => getStoredAddress());

  // Find-on-page
  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");

  // Refresh wallet badge whenever the wallet panel opens.
  useEffect(() => {
    if (sideTab === "wallet" || showSidePanel) {
      setWalletAddress(getStoredAddress());
    }
  }, [sideTab, showSidePanel]);

  // ── Page snapshot for the AI panel — always reads the active tab. ───────
  const getPageSnapshot = useCallback(async (): Promise<PageSnapshot | null> => {
    const wv = getWebview(activeId);
    if (!wv) return null;
    try {
      const script = `(() => {
        const clone = document.body ? document.body.cloneNode(true) : null;
        if (clone) {
          for (const sel of ['script', 'style', 'noscript', 'svg']) {
            for (const el of clone.querySelectorAll(sel)) el.remove();
          }
        }
        return JSON.stringify({
          url: location.href,
          title: document.title || '',
          text: (clone ? clone.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim(),
        });
      })()`;
      const raw = await wv.executeJavaScript(script);
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      console.warn("getPageSnapshot failed", err);
      return null;
    }
  }, [activeId, getWebview]);

  // ── Navigation helpers (act on the active tab) ──────────────────────────
  const navigate = useCallback(
    (input: string) => {
      const url = normalizeUrl(input);
      if (!activeTab) return;
      updateTab(activeTab.id, { addressInput: url });
      const wv = getWebview(activeTab.id);
      if (wv) wv.loadURL(url);
      else updateTab(activeTab.id, { url });
    },
    [activeTab, updateTab, getWebview],
  );

  const handleAddressSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (activeTab) navigate(activeTab.addressInput);
  };

  const handleReload = () => {
    const wv = activeTab ? getWebview(activeTab.id) : null;
    if (!wv) return;
    if (activeTab?.isLoading) wv.stop();
    else wv.reload();
  };

  const handleOpenExternal = () => {
    if (activeTab) window.open(activeTab.url, "_blank");
  };

  const openSideTab = useCallback((t: SidePanelTab) => {
    setSideTab(t);
    setShowSidePanel(true);
  }, []);

  // ── Keyboard shortcuts: Ctrl+T / Ctrl+W / Ctrl+F / Ctrl+Tab ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === "Escape" && showFind) {
          setShowFind(false);
          getWebview(activeId)?.stopFindInPage("clearSelection");
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        openTab();
      } else if (k === "w") {
        e.preventDefault();
        if (activeId) closeTab(activeId);
      } else if (k === "f") {
        e.preventDefault();
        setShowFind(true);
      } else if (k === "tab") {
        e.preventDefault();
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        const dir = e.shiftKey ? -1 : 1;
        const next = tabs[(idx + dir + tabs.length) % tabs.length];
        setActiveId(next.id);
      } else if (k === "l") {
        // Focus address bar
        e.preventDefault();
        const inp = document.querySelector<HTMLInputElement>("[data-joy-address-bar]");
        inp?.focus();
        inp?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openTab, closeTab, setActiveId, activeId, tabs, showFind, getWebview]);

  const runFind = useCallback(
    (q: string, forward = true) => {
      const wv = getWebview(activeId);
      if (!wv) return;
      if (!q) {
        wv.stopFindInPage("clearSelection");
        return;
      }
      wv.findInPage(q, { forward, findNext: false });
    },
    [activeId, getWebview],
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-background">
      {/* ── Tab strip ───────────────────────────────────────────────── */}
      <BrowserTabBar
        tabs={tabs}
        activeId={activeId}
        onActivate={setActiveId}
        onClose={closeTab}
        onCloseOthers={closeOthers}
        onNewTab={() => openTab()}
        onTogglePinned={togglePinned}
        onDuplicate={duplicateTab}
        onReorder={reorderTab}
      />

      {/* ── Nav Bar ─────────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border/50 bg-gradient-to-r from-sky-500/5 via-blue-500/5 to-violet-500/5">
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Navigation buttons */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!activeTab?.canGoBack}
              onClick={() => activeTab && getWebview(activeTab.id)?.goBack()}
              title="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!activeTab?.canGoForward}
              onClick={() => activeTab && getWebview(activeTab.id)?.goForward()}
              title="Forward"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleReload}
              title={activeTab?.isLoading ? "Stop" : "Reload"}
            >
              {activeTab?.isLoading ? (
                <X className="h-4 w-4 animate-pulse text-red-500" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => navigate("https://joycreate.io")}
              title="Home"
            >
              <Home className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Address bar */}
          <form onSubmit={handleAddressSubmit} className="flex-1 flex items-center gap-2 min-w-0">
            <div className="flex-1 flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 h-8 focus-within:border-primary/60 focus-within:bg-background transition-colors">
              <span className="shrink-0">
                {activeTab?.isSecure ? (
                  <Lock className="h-3 w-3 text-green-500" />
                ) : (
                  <Unlock className="h-3 w-3 text-amber-500" />
                )}
              </span>
              <Input
                data-joy-address-bar
                value={activeTab?.addressInput ?? ""}
                onChange={(e) => activeTab && updateTab(activeTab.id, { addressInput: e.target.value })}
                onFocus={(e) => e.target.select()}
                className="border-0 bg-transparent h-full p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
                placeholder="Enter a URL or search query…"
                spellCheck={false}
              />
            </div>
          </form>

          {/* Right actions */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => openSideTab("ai")}
              title="Open AI panel"
            >
              <Sparkles className="h-3.5 w-3.5 text-violet-500" />
              <span className="hidden @sm:inline">Ask AI</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => openSideTab("wallet")}
              title={
                walletAddress
                  ? `JoyWallet: ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
                  : "Connect wallet"
              }
            >
              <WalletIcon className="h-3.5 w-3.5 text-amber-500" />
              <span className="hidden @sm:inline">
                {walletAddress
                  ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
                  : "Connect"}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setShowFind((v) => !v)}
              title="Find on page (Ctrl+F)"
            >
              <Search className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => openSideTab("privacy")}
              title="Privacy & data ownership"
            >
              <Shield className="h-3.5 w-3.5 text-emerald-500" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleOpenExternal}
              title="Open in system browser"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
            <Separator orientation="vertical" className="h-5" />
            <Button
              variant={showSidePanel ? "secondary" : "ghost"}
              size="icon"
              className="h-7 w-7"
              onClick={() => setShowSidePanel((v) => !v)}
              title="Toggle side panel"
            >
              {showSidePanel ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        {/* Bookmarks bar */}
        <div className="flex items-center gap-1 px-3 pb-1.5 overflow-x-auto scrollbar-thin">
          {DEFAULT_BOOKMARKS.map((bm) => (
            <button
              key={bm.url}
              type="button"
              onClick={() => navigate(bm.url)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  openTab(bm.url, { background: true });
                }
              }}
              className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <Globe className="h-3 w-3" />
              {bm.label}
            </button>
          ))}
        </div>

        {/* Loading bar */}
        {activeTab?.isLoading && (
          <div className="px-3 pb-1">
            <div className="h-0.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary animate-[loading_1s_ease-in-out_infinite] rounded-full w-1/3" />
            </div>
          </div>
        )}
      </div>

      {/* ── Browser + side panel ─────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Webview stack — every tab mounted, only active visible */}
        <div className="flex-1 min-w-0 relative">
          {tabs.map((t) => (
            <BrowserWebview
              key={t.id}
              tab={t}
              isActive={t.id === activeId}
              partition={PARTITION}
              onUpdate={updateTab}
              onMount={registerWebview}
              onOpenNewTab={(url) => openTab(url, { background: true })}
            />
          ))}

          {/* Find-on-page bar */}
          {showFind && (
            <div className="absolute top-2 right-2 z-10 flex items-center gap-1 bg-background/95 backdrop-blur border border-border rounded-md shadow-lg p-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground ml-1" />
              <Input
                autoFocus
                value={findQuery}
                onChange={(e) => {
                  setFindQuery(e.target.value);
                  runFind(e.target.value, true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runFind(findQuery, !e.shiftKey);
                  }
                }}
                placeholder="Find…"
                className="h-7 w-48 text-xs"
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => {
                  setShowFind(false);
                  getWebview(activeId)?.stopFindInPage("clearSelection");
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>

        {/* Side panel */}
        {showSidePanel && (
          <div className="w-96 shrink-0 border-l border-border/50 overflow-hidden bg-background flex flex-col">
            <div className="flex border-b border-border/50 bg-muted/20">
              {(
                [
                  { id: "ai" as const, label: "AI", icon: Sparkles, color: "text-violet-500" },
                  { id: "wallet" as const, label: "Wallet", icon: WalletIcon, color: "text-amber-500" },
                  { id: "privacy" as const, label: "Data", icon: Shield, color: "text-emerald-500" },
                ]
              ).map((tt) => {
                const Icon = tt.icon;
                const active = sideTab === tt.id;
                return (
                  <button
                    key={tt.id}
                    type="button"
                    onClick={() => setSideTab(tt.id)}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-1.5 text-xs py-2 border-b-2 transition-colors",
                      active
                        ? "border-primary text-foreground bg-background"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40",
                    )}
                  >
                    <Icon className={cn("h-3.5 w-3.5", active && tt.color)} />
                    {tt.label}
                  </button>
                );
              })}
            </div>
            <div className="flex-1 min-h-0">
              {sideTab === "ai" && <BrowserAiPanel getPageSnapshot={getPageSnapshot} />}
              {sideTab === "wallet" && <JoyWalletPanel />}
              {sideTab === "privacy" && <PrivacyPanel />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
