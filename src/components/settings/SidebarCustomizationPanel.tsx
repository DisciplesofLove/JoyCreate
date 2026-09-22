import { useMemo, useState } from "react";
import { RotateCcw, Search } from "lucide-react";

import { menuCategories } from "@/components/app-sidebar";
import {
  getAllSidebarItems,
  getSidebarItemStage,
  isSidebarItemVisible,
  sidebarItemId,
  type SidebarStage,
} from "@/components/sidebar-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/useSettings";
import type { SidebarPreferences } from "@/lib/schemas";
import { cn } from "@/lib/utils";

function stageLabel(stage: SidebarStage): string {
  return stage === "beta" ? "Beta" : "In development";
}

/**
 * Settings panel that lets the user choose which sidebar navigation items are
 * shown. Stable items are visible by default and can be hidden; beta and
 * in-development items are hidden by default and can be revealed either
 * individually or via the per-stage master switches.
 */
export function SidebarCustomizationPanel() {
  const { settings, updateSettings } = useSettings();
  const [search, setSearch] = useState("");

  const prefs = settings?.sidebar;
  const allItems = useMemo(() => getAllSidebarItems(menuCategories), []);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return allItems;
    }
    return allItems.filter(
      ({ category, item }) =>
        item.title.toLowerCase().includes(query) ||
        category.toLowerCase().includes(query),
    );
  }, [allItems, search]);

  const groupedItems = useMemo(() => {
    const groups: Array<{ label: string; items: typeof allItems }> = [];
    for (const entry of filteredItems) {
      let group = groups.find((g) => g.label === entry.category);
      if (!group) {
        group = { label: entry.category, items: [] };
        groups.push(group);
      }
      group.items.push(entry);
    }
    return groups;
  }, [filteredItems]);

  const savePrefs = (next: SidebarPreferences) => {
    void updateSettings({ sidebar: next });
  };

  const setShowStage = (stage: SidebarStage, value: boolean) => {
    savePrefs({
      ...prefs,
      ...(stage === "beta" ? { showBeta: value } : { showDev: value }),
    });
  };

  const toggleItem = (
    item: { to: string },
    stage: SidebarStage | undefined,
    nextVisible: boolean,
  ) => {
    const id = sidebarItemId(item);

    if (!stage) {
      // Stable item — controlled via hiddenItems.
      const hiddenItems = new Set(prefs?.hiddenItems ?? []);
      if (nextVisible) {
        hiddenItems.delete(id);
      } else {
        hiddenItems.add(id);
      }
      savePrefs({ ...prefs, hiddenItems: Array.from(hiddenItems) });
      return;
    }

    // Beta / dev item — controlled via enabledItems, and we also clear any
    // explicit hide so the toggle reflects the on state.
    const enabledItems = new Set(prefs?.enabledItems ?? []);
    const hiddenItems = new Set(prefs?.hiddenItems ?? []);
    if (nextVisible) {
      enabledItems.add(id);
      hiddenItems.delete(id);
    } else {
      enabledItems.delete(id);
      hiddenItems.add(id);
    }
    savePrefs({
      ...prefs,
      enabledItems: Array.from(enabledItems),
      hiddenItems: Array.from(hiddenItems),
    });
  };

  const resetToDefaults = () => {
    savePrefs({});
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Sidebar
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Choose which navigation items appear in the sidebar. Hiding an item
            only removes it from the menu — the page is still reachable by its
            URL.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={resetToDefaults}
          className="shrink-0"
        >
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          Reset to defaults
        </Button>
      </div>

      {/* Stage master switches */}
      <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-white">
              Show beta features
            </span>
            <Badge variant="secondary">Beta</Badge>
          </div>
          <Switch
            checked={!!prefs?.showBeta}
            onCheckedChange={(checked) => setShowStage("beta", checked)}
          />
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-white">
              Show in-development features
            </span>
            <Badge variant="outline">In development</Badge>
          </div>
          <Switch
            checked={!!prefs?.showDev}
            onCheckedChange={(checked) => setShowStage("dev", checked)}
          />
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search items…"
          className="pl-9"
        />
      </div>

      {/* Per-item toggles */}
      <div className="space-y-5">
        {groupedItems.map((group) => (
          <div key={group.label} className="space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {group.label}
            </h4>
            <div className="divide-y divide-gray-100 dark:divide-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              {group.items.map(({ item }) => {
                const stage = getSidebarItemStage(item);
                const visible = isSidebarItemVisible(item, prefs);
                const Icon = item.icon;
                return (
                  <div
                    key={sidebarItemId(item)}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          visible
                            ? "text-gray-700 dark:text-gray-200"
                            : "text-gray-400 dark:text-gray-600",
                        )}
                      />
                      <span
                        className={cn(
                          "truncate text-sm",
                          visible
                            ? "text-gray-900 dark:text-white"
                            : "text-gray-400 dark:text-gray-600",
                        )}
                      >
                        {item.title}
                      </span>
                      {stage && (
                        <Badge
                          variant={stage === "beta" ? "secondary" : "outline"}
                          className="shrink-0"
                        >
                          {stageLabel(stage)}
                        </Badge>
                      )}
                    </div>
                    <Switch
                      checked={visible}
                      onCheckedChange={(checked) =>
                        toggleItem(item, stage, checked)
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {groupedItems.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No items match “{search}”.
          </p>
        )}
      </div>
    </div>
  );
}
