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
import { useNavigate as useRouterNavigate } from "@tanstack/react-router";
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
  Puzzle,
  Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";

import { BrowserAiPanel, type PageSnapshot } from "@/components/smart-browser/BrowserAiPanel";
import { JoyWalletPanel } from "@/components/smart-browser/JoyWalletPanel";
import { PrivacyPanel } from "@/components/smart-browser/PrivacyPanel";
import { BrowserTabBar } from "@/components/smart-browser/BrowserTabBar";
import { BrowserWebview } from "@/components/smart-browser/BrowserWebview";
import { BrowserPluginsPanel } from "@/components/smart-browser/BrowserPluginsPanel";
import { BrowserAgentPanel } from "@/components/smart-browser/BrowserAgentPanel";

import { useBrowserTabs } from "@/hooks/useBrowserTabs";
import { useBrowserPlugins } from "@/hooks/useBrowserPlugins";
import { getStoredAddress } from "@/lib/joy_wallet";
import { joySearchClient } from "@/ipc/clients/joy_search_client";
import type { BrowserPlugin } from "@/types/browser_plugin";

const PARTITION = "persist:joybrowser";

type SidePanelTab = "ai" | "agent" | "wallet" | "privacy" | "plugins";

// ── Bookmarks (user-editable, persisted) ───────────────────────────────────
const DEFAULT_BOOKMARKS = [
  { label: "JoyCreate", url: "https://joycreate.io" },
  { label: "OpenClaw Docs", url: "https://docs.openclaw.ai" },
  { label: "Ollama", url: "http://localhost:11434" },
  { label: "n8n", url: "http://localhost:5678" },
  { label: "Goldsky", url: "https://goldsky.com" },
  { label: "Hugging Face", url: "https://huggingface.co" },
];

type Bookmark = { label: string; url: string };
function loadBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem("joy-browser-bookmarks");
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_BOOKMARKS;
}
function saveBookmarks(bms: Bookmark[]) {
  try {
    localStorage.setItem("joy-browser-bookmarks", JSON.stringify(bms));
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decide whether the user typed a URL or a search query.
 * Returns `{ kind: "search", query }` for free-text searches so the caller
 * can route to internal JoySearch instead of Google.
 */
function classifyAddressInput(
  input: string,
): { kind: "url"; url: string } | { kind: "search"; query: string } {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "url", url: "about:blank" };
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("about:")) {
    return { kind: "url", url: trimmed };
  }
  if (/^(localhost|127\.|192\.168\.|10\.)/i.test(trimmed)) {
    return { kind: "url", url: `http://${trimmed}` };
  }
  if (/\.[a-z]{2,}/i.test(trimmed) && !trimmed.includes(" ")) {
    return { kind: "url", url: `https://${trimmed}` };
  }
  return { kind: "search", query: trimmed };
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SmartBrowserPage() {
    // Bookmarks state
    const [bookmarks, setBookmarks] = useState<Bookmark[]>(() => loadBookmarks());
    // Menu state
    const [showMenu, setShowMenu] = useState(false);
    // Add current page as bookmark
    const handleBookmarkPage = () => {
      if (!activeTab?.url) return;
      const url = activeTab.url;
      // Use page title or URL as label
      const label = (activeTab.title || url).slice(0, 48);
      // Avoid duplicates
      if (bookmarks.some((b) => b.url === url)) return;
      const next = [...bookmarks, { label, url }];
      setBookmarks(next);
      saveBookmarks(next);
      setShowMenu(false);
    };

    // Remove a bookmark (future: manage UI)
    const removeBookmark = (url: string) => {
      const next = bookmarks.filter((b) => b.url !== url);
      setBookmarks(next);
      saveBookmarks(next);
    };
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
  //
  // Two-stage strategy:
  //   1. In-page extraction via wv.executeJavaScript (best quality, sees
  //      logged-in content, dynamic SPA state).
  //   2. Server-side fallback via JoySearch's readability extractor, which
  //      re-fetches the URL from Node. Works even when the webview ref is
  //      missing, the guest page hasn't attached, or the in-page script
  //      was blocked by CSP.
  //
  // We only throw when BOTH paths fail. The user-facing message is
  // rendered verbatim by BrowserAiPanel.
  const getPageSnapshot = useCallback(async (): Promise<PageSnapshot> => {
    const currentUrl = activeTab?.url ?? "";

    // Helper: server-side fetch + readability. Used as fallback.
    const fetchServerSide = async (): Promise<PageSnapshot | null> => {
      if (!/^https?:\/\//i.test(currentUrl)) return null;
      try {
        const res = await joySearchClient.fetchPage({ url: currentUrl });
        if (!res?.text || res.text.length < 50) return null;
        return {
          url: res.finalUrl ?? res.url ?? currentUrl,
          title: res.title ?? activeTab?.title ?? "",
          text: res.text,
          description: res.excerpt,
          siteName: undefined,
          headings: undefined,
        };
      } catch (err) {
        console.warn("[getPageSnapshot] server-side fallback failed", err);
        return null;
      }
    };

    // Reject internal / non-extractable URLs up-front — but still try the
    // active webview's executeJavaScript path for plain http(s) and try
    // server-side for the same. Both will fail and we'll throw a tailored
    // error.
    if (
      /^(about:|chrome:|chrome-error:|edge:|view-source:|devtools:|joycreate:|file:)/i.test(
        currentUrl,
      )
    ) {
      throw new Error(
        `Internal URL "${currentUrl.split(/[?#]/)[0] || "about:blank"}" can't be read by the AI. Open a public webpage first.`,
      );
    }
    if (/\.(pdf|epub|mobi|zip|exe|dmg|mp4|mp3)(\?|$)/i.test(currentUrl)) {
      throw new Error(
        "This document type can't be summarised by the in-page reader. Try the page it came from.",
      );
    }

    // 1) Try in-page extraction. Poll briefly for the webview ref but
    //    don't fail hard if it's missing — we have the server fallback.
    const findWebview = async (): Promise<Electron.WebviewTag | null> => {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const w = getWebview(activeId);
        if (w) return w;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    };
    const wv = await findWebview();

    const waitForReady = (w: Electron.WebviewTag): Promise<void> =>
      new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          w.removeEventListener("dom-ready", finish as EventListener);
          w.removeEventListener("did-stop-loading", finish as EventListener);
          w.removeEventListener("did-finish-load", finish as EventListener);
          resolve();
        };
        try {
          if (!w.isLoading()) {
            setTimeout(finish, 100);
            return;
          }
        } catch {
          /* isLoading throws when not yet attached — wait for events */
        }
        w.addEventListener("dom-ready", finish as EventListener, { once: true });
        w.addEventListener("did-stop-loading", finish as EventListener, {
          once: true,
        });
        w.addEventListener("did-finish-load", finish as EventListener, {
          once: true,
        });
        setTimeout(finish, 4000);
      });

    const script = `(() => {
      try {
        const cleanText = (t) =>
          (t || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
        const candidates = [];
        const push = (el) => { if (el && !candidates.includes(el)) candidates.push(el); };
        document.querySelectorAll('article, main, [role=main], #main, #content, .content, .post, .article').forEach(push);
        if (candidates.length === 0 && document.body) push(document.body);
        let best = null;
        let bestScore = 0;
        for (const el of candidates) {
          const txt = el.innerText || '';
          const links = el.querySelectorAll('a').length;
          const score = txt.length * Math.max(0.1, 1 - links / Math.max(1, txt.length / 80));
          if (score > bestScore) { bestScore = score; best = el; }
        }
        const root = best || document.body;
        if (!root) return JSON.stringify({ ok: false, reason: 'no-body' });
        const clone = root.cloneNode(true);
        for (const sel of ['script','style','noscript','svg','iframe','nav','aside','header','footer','form','button']) {
          for (const el of clone.querySelectorAll(sel)) el.remove();
        }
        const text = cleanText(clone.innerText || '');
        const headings = [];
        for (const h of document.querySelectorAll('h1, h2, h3')) {
          const t = (h.textContent || '').trim();
          if (t && t.length < 200) headings.push(t);
          if (headings.length >= 12) break;
        }
        const meta = (name) => {
          const el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
          return el ? (el.getAttribute('content') || '').trim() : '';
        };
        return JSON.stringify({
          ok: true,
          url: location.href,
          title: document.title || '',
          description: meta('description') || meta('og:description') || '',
          siteName: meta('og:site_name') || '',
          headings,
          text,
        });
      } catch (e) {
        return JSON.stringify({ ok: false, reason: 'script-error', message: String(e && e.message || e) });
      }
    })()`;

    type RawSnap = {
      ok: boolean;
      url?: string;
      title?: string;
      description?: string;
      siteName?: string;
      headings?: string[];
      text?: string;
      reason?: string;
      message?: string;
    };

    const tryInPage = async (): Promise<PageSnapshot | null> => {
      if (!wv) return null;
      try {
        await waitForReady(wv);
      } catch {
        /* swallow — we still try executeJavaScript */
      }
      const backoffs = [0, 350, 800, 1500];
      for (const ms of backoffs) {
        if (ms) await new Promise((r) => setTimeout(r, ms));
        try {
          const raw = await wv.executeJavaScript(script);
          const parsed: RawSnap | null =
            typeof raw === "string" ? JSON.parse(raw) : (raw as RawSnap);
          if (
            parsed?.ok &&
            typeof parsed.text === "string" &&
            parsed.text.trim().length >= 50
          ) {
            return {
              url: parsed.url ?? currentUrl,
              title: parsed.title ?? activeTab?.title ?? "",
              text: parsed.text.trim(),
              description: parsed.description,
              siteName: parsed.siteName,
              headings: parsed.headings,
            };
          }
        } catch (err) {
          console.warn("[getPageSnapshot] in-page attempt failed", err);
        }
      }
      return null;
    };

    // Run both in parallel — server-side is independent and often faster
    // than waiting for an SPA to settle.
    const [inPage, serverSide] = await Promise.all([
      tryInPage(),
      fetchServerSide(),
    ]);
    const snap = inPage ?? serverSide;
    if (snap) return snap;

    // Both failed — produce a precise diagnostic.
    if (!currentUrl || currentUrl === "about:blank") {
      throw new Error(
        "This tab has no page loaded. Type a URL in the address bar and try again.",
      );
    }
    if (!wv) {
      throw new Error(
        `Couldn't read the page and the server-side fallback also failed. The URL "${currentUrl}" may be unreachable from the network or blocked by CORS.`,
      );
    }
    throw new Error(
      "The page is loaded but has very little extractable text (likely a JS-heavy app that hasn't finished rendering). Wait a moment and try again.",
    );
  }, [activeId, activeTab?.url, activeTab?.title, getWebview]);

  // ── Plugin runner — executes plugin.code inside the active webview. ─────
  const { data: plugins = [] } = useBrowserPlugins();
  const runPluginInActiveWebview = useCallback(
    async (plugin: BrowserPlugin): Promise<unknown> => {
      const wv = getWebview(activeId);
      if (!wv) throw new Error("No active tab");
      try {
        if (wv.isLoading()) {
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              wv.removeEventListener("did-stop-loading", finish as EventListener);
              resolve();
            };
            wv.addEventListener("did-stop-loading", finish as EventListener, {
              once: true,
            });
            setTimeout(finish, 2500);
          });
        }
      } catch {
        /* isLoading throws when not yet attached — proceed */
      }
      // Plugins return their raw value — Electron auto-marshalls primitives,
      // arrays, and plain objects. We DO NOT JSON.stringify on the page side
      // so the user-authored plugin can return any of those shapes.
      return wv.executeJavaScript(plugin.code);
    },
    [activeId, getWebview],
  );

  // ── Navigation helpers (act on the active tab) ──────────────────────────
  const routerNavigate = useRouterNavigate();
  const navigate = useCallback(
    (input: string) => {
      const parsed = classifyAddressInput(input);
      if (parsed.kind === "search") {
        // Free-text query → send to local JoySearch instead of Google.
        routerNavigate({ to: "/joy-search", search: { q: parsed.query } });
        return;
      }
      const url = parsed.url;
      if (!activeTab) return;
      updateTab(activeTab.id, { addressInput: url });
      const wv = getWebview(activeTab.id);
      if (wv) wv.loadURL(url);
      else updateTab(activeTab.id, { url });
    },
    [activeTab, updateTab, getWebview, routerNavigate],
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
          <div className="flex items-center gap-1 relative">
                    {/* Three dots menu */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setShowMenu((v) => !v)}
                      title="More actions"
                    >
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="3.5" r="1.5" fill="currentColor"/><circle cx="9" cy="9" r="1.5" fill="currentColor"/><circle cx="9" cy="14.5" r="1.5" fill="currentColor"/></svg>
                    </Button>
                    {showMenu && (
                      <div className="absolute right-0 top-9 z-50 min-w-[180px] bg-popover border border-border rounded shadow-lg py-1 animate-in fade-in slide-in-from-top-2">
                        <button
                          className="w-full text-left px-4 py-2 text-sm hover:bg-muted/40"
                          onClick={handleBookmarkPage}
                          disabled={!activeTab?.url || bookmarks.some((b) => b.url === activeTab.url)}
                        >
                          {bookmarks.some((b) => b.url === activeTab?.url)
                            ? "Bookmarked"
                            : "Bookmark this page"}
                        </button>
                        {/* Future: manage bookmarks, settings, etc. */}
                      </div>
                    )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() =>
                routerNavigate({
                  to: "/joy-search",
                  search: { q: activeTab?.addressInput ?? "" },
                })
              }
              title="Open JoySearch — local-AI web search"
            >
              <Search className="h-3.5 w-3.5 text-sky-500" />
              <span className="hidden @sm:inline">JoySearch</span>
            </Button>
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
              onClick={() => openSideTab("plugins")}
              title="Browser plugins"
            >
              <Puzzle className="h-3.5 w-3.5 text-emerald-500" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => openSideTab("agent")}
              title="Autonomous web agent"
            >
              <Bot className="h-3.5 w-3.5 text-sky-500" />
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
          {bookmarks.map((bm) => (
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
              className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground group"
              title={bm.url}
            >
              <Globe className="h-3 w-3" />
              {bm.label}
              {/* Remove button (hidden by default, show on hover, for future manage UI) */}
              {/* <span
                className="ml-1 text-[10px] text-red-400 opacity-0 group-hover:opacity-100 cursor-pointer"
                onClick={(e) => { e.stopPropagation(); removeBookmark(bm.url); }}
              >×</span> */}
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
                  { id: "agent" as const, label: "Agent", icon: Bot, color: "text-sky-500" },
                  { id: "plugins" as const, label: "Plugins", icon: Puzzle, color: "text-emerald-500" },
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
              {sideTab === "ai" && (
                <BrowserAiPanel
                  getPageSnapshot={getPageSnapshot}
                  pageActionPlugins={plugins}
                  runPluginInActiveWebview={runPluginInActiveWebview}
                />
              )}
              {sideTab === "agent" && (
                <BrowserAgentPanel
                  getActiveWebview={() => getWebview(activeId)}
                  openTab={(url, opts) => openTab(url, opts)}
                />
              )}
              {sideTab === "plugins" && (
                <BrowserPluginsPanel
                  currentUrl={activeTab?.url}
                  runPluginInActiveWebview={runPluginInActiveWebview}
                />
              )}
              {sideTab === "wallet" && <JoyWalletPanel />}
              {sideTab === "privacy" && <PrivacyPanel />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
