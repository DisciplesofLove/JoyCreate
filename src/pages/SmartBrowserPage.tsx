/**
 * Smart Browser — AI-augmented in-app web browser.
 *
 * Renders a full-page Electron <webview> with a navigation bar, AI
 * summarisation shortcut, and a side-panel for the OpenClaw CNS widget.
 *
 * Requires `webviewTag: true` in main BrowserWindow webPreferences.
 */

import { useRef, useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "@tanstack/react-router";
import { CNSDashboard } from "@/components/openclaw/CNSDashboard";

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
  // Already a URL with scheme
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("about:")) return trimmed;
  // localhost / IP addresses without scheme
  if (/^(localhost|127\.|192\.168\.|10\.)/i.test(trimmed)) return `http://${trimmed}`;
  // Looks like a domain (contains a dot)
  if (/\.[a-z]{2,}/i.test(trimmed) && !trimmed.includes(" ")) return `https://${trimmed}`;
  // Treat as a search query
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SmartBrowserPage() {
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const [addressInput, setAddressInput] = useState("https://joycreate.io");
  const [currentUrl, setCurrentUrl] = useState("https://joycreate.io");
  const [isLoading, setIsLoading] = useState(false);
  const [isSecure, setIsSecure] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState("");
  const [showSidePanel, setShowSidePanel] = useState(false);

  // Attach webview event listeners once the element mounts
  const attachWebviewListeners = useCallback((wv: Electron.WebviewTag) => {
    wv.addEventListener("did-start-loading", () => setIsLoading(true));
    wv.addEventListener("did-stop-loading", () => {
      setIsLoading(false);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    });
    wv.addEventListener("did-navigate", (e) => {
      const url = (e as Electron.DidNavigateEvent).url;
      setCurrentUrl(url);
      setAddressInput(url);
      setIsSecure(url.startsWith("https://") || url.startsWith("about:") || url.startsWith("http://localhost"));
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    });
    wv.addEventListener("did-navigate-in-page", (e) => {
      const url = (e as Electron.DidNavigateInPageEvent).url;
      setCurrentUrl(url);
      setAddressInput(url);
      setCanGoBack(wv.canGoBack());
      setCanGoForward(wv.canGoForward());
    });
    wv.addEventListener("page-title-updated", (e) => {
      setPageTitle((e as Electron.PageTitleUpdatedEvent).title);
    });
  }, []);

  // Capture the webview DOM node via callback ref
  const webviewCallbackRef = useCallback(
    (node: HTMLElement | null) => {
      if (node) {
        webviewRef.current = node as unknown as Electron.WebviewTag;
        attachWebviewListeners(webviewRef.current);
      }
    },
    [attachWebviewListeners],
  );

  const navigate = useCallback((input: string) => {
    const url = normalizeUrl(input);
    setAddressInput(url);
    webviewRef.current?.loadURL(url);
  }, []);

  const handleAddressSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(addressInput);
  };

  const handleReload = () => {
    if (isLoading) {
      webviewRef.current?.stop();
    } else {
      webviewRef.current?.reload();
    }
  };

  const handleOpenExternal = () => {
    window.open(currentUrl, "_blank");
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-background">
      {/* ── Nav Bar ─────────────────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border/50 bg-gradient-to-r from-sky-500/5 via-blue-500/5 to-violet-500/5">
        {/* Top row: back/forward/reload + address + actions */}
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Navigation buttons */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!canGoBack}
              onClick={() => webviewRef.current?.goBack()}
              title="Back"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              disabled={!canGoForward}
              onClick={() => webviewRef.current?.goForward()}
              title="Forward"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleReload}
              title={isLoading ? "Stop" : "Reload"}
            >
              {isLoading ? (
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
                {isSecure ? (
                  <Lock className="h-3 w-3 text-green-500" />
                ) : (
                  <Unlock className="h-3 w-3 text-amber-500" />
                )}
              </span>
              <Input
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
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
              title="Toggle OpenClaw AI panel"
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
              className="shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <Globe className="h-3 w-3" />
              {bm.label}
            </button>
          ))}
        </div>

        {/* Page title / loading bar */}
        {(pageTitle || isLoading) && (
          <div className="px-3 pb-1 flex items-center gap-2">
            {isLoading && (
              <div className="h-0.5 flex-1 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary animate-[loading_1s_ease-in-out_infinite] rounded-full w-1/3" />
              </div>
            )}
            {!isLoading && pageTitle && (
              <span className="text-xs text-muted-foreground truncate">{pageTitle}</span>
            )}
          </div>
        )}
      </div>

      {/* ── Browser + side panel ─────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Webview */}
        <div className="flex-1 min-w-0 relative">
          {/* @ts-expect-error webview is an Electron-specific intrinsic */}
          <webview
            ref={webviewCallbackRef}
            src={currentUrl}
            className="absolute inset-0 w-full h-full border-none"
            allowpopups="true"
            disablewebsecurity="false"
            nodeintegration="false"
          />
        </div>

        {/* OpenClaw AI side panel */}
        {showSidePanel && (
          <div className="w-96 shrink-0 border-l border-border/50 overflow-y-auto bg-background">
            <div className="sticky top-0 z-10 px-4 py-3 border-b border-border/50 bg-background/95 backdrop-blur flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              <span className="font-semibold text-sm">OpenClaw AI</span>
              <Badge variant="secondary" className="text-[10px] ml-auto">
                CNS
              </Badge>
            </div>
            <div className="p-2">
              <CNSDashboard />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
