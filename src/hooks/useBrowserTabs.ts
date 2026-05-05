/**
 * useBrowserTabs — multi-tab state for the Smart Browser.
 *
 * Each tab keeps its own URL, history state, title, loading & secure
 * flags. Tabs persist for the lifetime of the page (refreshing the
 * SPA route resets them — intentional, since cookies live in the
 * persistent partition not in this state).
 */

import { useCallback, useRef, useState } from "react";

export interface BrowserTab {
  id: string;
  url: string;
  /** What the user typed in the address bar (may not be the canonical URL yet). */
  addressInput: string;
  title: string;
  isLoading: boolean;
  isSecure: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Pinned tabs render smaller and aren't auto-closed by Close All Others. */
  pinned: boolean;
}

const HOME_URL = "https://joycreate.io";

let tabSeq = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now().toString(36)}-${tabSeq}`;
}

function createTab(url = HOME_URL, partial: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: newTabId(),
    url,
    addressInput: url,
    title: "",
    isLoading: false,
    isSecure: url.startsWith("https://") || url.startsWith("about:") || url.startsWith("http://localhost"),
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    ...partial,
  };
}

export function useBrowserTabs(initialUrl = HOME_URL) {
  // Lazily create the first tab so its id is stable across re-renders.
  const [{ tabs: initialTabs, activeId: initialActiveId }] = useState(() => {
    const t = createTab(initialUrl);
    return { tabs: [t], activeId: t.id };
  });
  const [tabs, setTabs] = useState<BrowserTab[]>(initialTabs);
  const [activeId, setActiveId] = useState<string>(initialActiveId);

  // Keep one webview element per tab so navigation state survives tab switches.
  const webviewsRef = useRef<Map<string, Electron.WebviewTag>>(new Map());

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null;

  // ── tab CRUD ────────────────────────────────────────────────────────────

  const openTab = useCallback((url: string = HOME_URL, opts?: { background?: boolean }) => {
    const t = createTab(url);
    setTabs((prev) => [...prev, t]);
    if (!opts?.background) setActiveId(t.id);
    return t.id;
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      // Pick a neighboring tab to activate.
      if (next.length === 0) {
        // Always keep at least one tab open.
        const fresh = createTab();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) {
        const newActive = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveId(newActive.id);
      }
      webviewsRef.current.delete(id);
      return next;
    });
  }, [activeId]);

  const closeOthers = useCallback((id: string) => {
    setTabs((prev) => {
      const keep = prev.filter((t) => t.id === id || t.pinned);
      if (keep.length === 0) return prev;
      // Drop refs for closed tabs.
      for (const t of prev) {
        if (!keep.find((k) => k.id === t.id)) webviewsRef.current.delete(t.id);
      }
      setActiveId(id);
      return keep;
    });
  }, []);

  const reorderTab = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const togglePinned = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)));
  }, []);

  const duplicateTab = useCallback((id: string) => {
    const src = tabs.find((t) => t.id === id);
    if (!src) return;
    openTab(src.url);
  }, [tabs, openTab]);

  // ── per-tab updates ─────────────────────────────────────────────────────

  const updateTab = useCallback((id: string, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  // ── webview ref management ──────────────────────────────────────────────

  const registerWebview = useCallback((id: string, wv: Electron.WebviewTag | null) => {
    if (wv) webviewsRef.current.set(id, wv);
    else webviewsRef.current.delete(id);
  }, []);

  const getWebview = useCallback((id: string): Electron.WebviewTag | undefined => {
    return webviewsRef.current.get(id);
  }, []);

  return {
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
  } as const;
}
