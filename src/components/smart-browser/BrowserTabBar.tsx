/**
 * BrowserTabBar — Chrome/Edge-style tab strip for the Smart Browser.
 *
 * Features:
 *  - Click to switch · middle-click to close · right-click for context menu
 *  - "+" button to open a new tab
 *  - Drag to reorder (HTML5 DnD)
 *  - Pinned tabs render compact and stick to the left
 */

import { useRef, useState } from "react";
import { Plus, X, Pin, PinOff, Copy, X as XIcon, Loader2, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BrowserTab } from "@/hooks/useBrowserTabs";

interface Props {
  tabs: BrowserTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onNewTab: () => void;
  onTogglePinned: (id: string) => void;
  onDuplicate: (id: string) => void;
  onReorder: (from: number, to: number) => void;
}

interface MenuState {
  tabId: string;
  x: number;
  y: number;
}

export function BrowserTabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCloseOthers,
  onNewTab,
  onTogglePinned,
  onDuplicate,
  onReorder,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const closeMenu = () => setMenu(null);

  return (
    <div
      className="flex items-end h-9 bg-gradient-to-b from-muted/30 to-muted/10 px-1 gap-0.5 border-b border-border/50 select-none"
      onClick={closeMenu}
    >
      {tabs.map((t, i) => {
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
            draggable
            onDragStart={() => {
              dragIndexRef.current = i;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragIndexRef.current;
              dragIndexRef.current = null;
              if (from !== null && from !== i) onReorder(from, i);
            }}
            onClick={(e) => {
              if (e.button === 0) onActivate(t.id);
            }}
            onMouseDown={(e) => {
              // Middle-click closes
              if (e.button === 1) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: t.id, x: e.clientX, y: e.clientY });
            }}
            title={t.title || t.url}
            className={cn(
              "group flex items-center gap-1.5 h-8 self-end px-2 rounded-t-md cursor-pointer text-xs transition-colors",
              t.pinned ? "max-w-[40px] min-w-[40px] justify-center" : "max-w-[180px] min-w-[100px]",
              isActive
                ? "bg-background border-x border-t border-border/50 text-foreground -mb-px"
                : "bg-muted/40 hover:bg-muted/70 text-muted-foreground border border-transparent",
            )}
          >
            {/* Favicon / loader */}
            <span className="shrink-0">
              {t.isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <Globe className="h-3 w-3 opacity-70" />
              )}
            </span>
            {!t.pinned && (
              <span className="truncate flex-1 min-w-0">
                {t.title || hostOf(t.url) || "New tab"}
              </span>
            )}
            {!t.pinned && tabs.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className="opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/20 rounded p-0.5 transition-opacity shrink-0"
                title="Close tab"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}

      {/* New tab button */}
      <button
        type="button"
        onClick={onNewTab}
        title="New tab (Ctrl+T)"
        className="ml-1 self-end mb-0.5 h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {/* Context menu */}
      {menu && (
        <div
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover shadow-lg py-1 text-xs"
          style={{ top: menu.y, left: menu.x }}
          onClick={closeMenu}
        >
          <MenuItem icon={Plus} label="New tab" onClick={onNewTab} />
          <MenuItem icon={Copy} label="Duplicate" onClick={() => onDuplicate(menu.tabId)} />
          <MenuItem
            icon={tabs.find((t) => t.id === menu.tabId)?.pinned ? PinOff : Pin}
            label={tabs.find((t) => t.id === menu.tabId)?.pinned ? "Unpin" : "Pin"}
            onClick={() => onTogglePinned(menu.tabId)}
          />
          <div className="h-px bg-border my-1" />
          <MenuItem icon={XIcon} label="Close tab" onClick={() => onClose(menu.tabId)} />
          <MenuItem icon={XIcon} label="Close others" onClick={() => onCloseOthers(menu.tabId)} />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-muted text-left"
    >
      <Icon className="h-3 w-3 text-muted-foreground" />
      {label}
    </button>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
