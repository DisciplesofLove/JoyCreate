/**
 * BrowserWebview — a single Electron <webview> wired into the
 * useBrowserTabs() state for one tab.
 *
 * Mounts ONCE per tab and stays mounted (hidden via CSS when inactive)
 * so navigation history, scroll position, and JS state survive tab
 * switching — same UX as Chrome/Edge.
 */

import { useCallback, useEffect, useRef } from "react";
import type { BrowserTab } from "@/hooks/useBrowserTabs";
import { recordVisit, tickProgramEarnings } from "@/lib/joy_browser_data_ledger";

interface Props {
  tab: BrowserTab;
  isActive: boolean;
  partition: string;
  /** Patch the tab in parent state. */
  onUpdate: (id: string, patch: Partial<BrowserTab>) => void;
  /** Register / unregister the underlying webview node so the parent
   *  can call `loadURL`, `goBack`, `findInPage` etc. on it. */
  onMount: (id: string, wv: Electron.WebviewTag | null) => void;
  /** Called when the user clicks a target=_blank link (Edge-style: open in new tab). */
  onOpenNewTab: (url: string) => void;
}

export function BrowserWebview({ tab, isActive, partition, onUpdate, onMount, onOpenNewTab }: Props) {
  const wvRef = useRef<Electron.WebviewTag | null>(null);

  const handleRef = useCallback(
    (node: HTMLElement | null) => {
      const wv = node as unknown as Electron.WebviewTag | null;
      wvRef.current = wv;
      onMount(tab.id, wv);
    },
    [tab.id, onMount],
  );

  // Wire listeners once the element is mounted.
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;

    const onStartLoad = () => onUpdate(tab.id, { isLoading: true });
    const onStopLoad = () =>
      onUpdate(tab.id, {
        isLoading: false,
        canGoBack: wv.canGoBack(),
        canGoForward: wv.canGoForward(),
      });
    const onNav = (e: Event) => {
      const url = (e as Electron.DidNavigateEvent).url;
      onUpdate(tab.id, {
        url,
        addressInput: url,
        isSecure: url.startsWith("https://") || url.startsWith("about:") || url.startsWith("http://localhost"),
        canGoBack: wv.canGoBack(),
        canGoForward: wv.canGoForward(),
      });
      try {
        const u = new URL(url);
        recordVisit({ url, host: u.host, title: tab.title });
        tickProgramEarnings("trend-panel", 1);
      } catch {
        /* non-URL navigations */
      }
    };
    const onNavInPage = (e: Event) => {
      const url = (e as Electron.DidNavigateInPageEvent).url;
      onUpdate(tab.id, {
        url,
        addressInput: url,
        canGoBack: wv.canGoBack(),
        canGoForward: wv.canGoForward(),
      });
    };
    const onTitle = (e: Event) => {
      onUpdate(tab.id, { title: (e as Electron.PageTitleUpdatedEvent).title });
    };
    const onNewWindow = (e: Event) => {
      // Open `target=_blank` / window.open() in a new tab instead of letting
      // Electron spawn an actual BrowserWindow.
      const url = (e as Electron.NewWindowEvent).url;
      if (url) onOpenNewTab(url);
    };

    wv.addEventListener("did-start-loading", onStartLoad);
    wv.addEventListener("did-stop-loading", onStopLoad);
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onNavInPage);
    wv.addEventListener("page-title-updated", onTitle);
    wv.addEventListener("new-window", onNewWindow);

    return () => {
      wv.removeEventListener("did-start-loading", onStartLoad);
      wv.removeEventListener("did-stop-loading", onStopLoad);
      wv.removeEventListener("did-navigate", onNav);
      wv.removeEventListener("did-navigate-in-page", onNavInPage);
      wv.removeEventListener("page-title-updated", onTitle);
      wv.removeEventListener("new-window", onNewWindow);
      onMount(tab.id, null);
    };
    // We intentionally don't depend on `tab.title` — the listener closes
    // over the latest title via the parent's recordVisit call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, onUpdate, onMount, onOpenNewTab]);

  return (
    <div
      className="absolute inset-0"
      style={{ display: isActive ? "block" : "none" }}
      aria-hidden={!isActive}
    >
      {/* @ts-expect-error webview is an Electron-specific intrinsic */}
      <webview
        ref={handleRef}
        src={tab.url}
        className="absolute inset-0 w-full h-full border-none"
        allowpopups="true"
        disablewebsecurity="false"
        nodeintegration="false"
        partition={partition}
      />
    </div>
  );
}
