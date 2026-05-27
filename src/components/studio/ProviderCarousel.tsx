/**
 * ProviderCarousel — horizontal, swipeable strip of every Image / Video
 * Studio provider. Surfaces all providers at a glance (not just the configured
 * ones), shows status badges, lets the user re-configure a provider at any
 * time (even after it's already been set up), and selects the provider on
 * click.
 *
 * Keeps the underlying picker model untouched — selecting a card here calls
 * `onSelect(providerId, firstSelectableModelId)` so it stays in sync with
 * `UnifiedModelPicker`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  KeyRound,
  Sparkles,
  Wifi,
  WifiOff,
  Settings2,
} from "lucide-react";
import type { ImageStudioProvider, VideoStudioProvider } from "@/ipc/ipc_types";
import { ApiKeyInlineDialog } from "./ApiKeyInlineDialog";
import type { StudioMode } from "./UnifiedModelPicker";

type AnyProvider = ImageStudioProvider | VideoStudioProvider;

interface Props {
  mode: StudioMode;
  providers: AnyProvider[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (providerId: string, modelId: string) => void;
  className?: string;
}

interface KeyDialogTarget {
  providerId: string;
  providerLabel: string;
  envVars?: string[];
  website?: string;
}

export function ProviderCarousel({
  mode,
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  className,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [keyDialog, setKeyDialog] = useState<KeyDialogTarget | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const queryClient = useQueryClient();

  function updateScrollState() {
    const el = scrollerRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }

  useEffect(() => {
    updateScrollState();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      ro.disconnect();
    };
  }, [providers.length]);

  function scrollBy(delta: number) {
    scrollerRef.current?.scrollBy({ left: delta, behavior: "smooth" });
  }

  const sorted = useMemo(() => {
    // Configured first, then needs-key, then local-offline, then coming-soon.
    const rank = (p: AnyProvider) => {
      if (p.comingSoon) return 4;
      if (p.kind === "local" && p.health !== "ok") return 3;
      if (p.kind === "cloud" && !p.configured) return 2;
      return 1;
    };
    return [...providers].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return a.label.localeCompare(b.label);
    });
  }, [providers]);

  function handleCardClick(provider: AnyProvider) {
    if (provider.comingSoon) return;
    if (provider.kind === "cloud" && !provider.configured) {
      setKeyDialog({
        providerId: provider.id,
        providerLabel: provider.label,
        envVars: provider.apiKeyEnvVars,
        website: provider.website,
      });
      return;
    }
    const firstModel =
      provider.models.find((m) => !m.comingSoon) ?? provider.models[0];
    if (!firstModel) return;
    onSelect(provider.id, firstModel.id);
  }

  function handleReconfigure(e: React.MouseEvent, provider: AnyProvider) {
    e.stopPropagation();
    setKeyDialog({
      providerId: provider.id,
      providerLabel: provider.label,
      envVars: provider.apiKeyEnvVars,
      website: provider.website,
    });
  }

  function handleSaved() {
    queryClient.invalidateQueries({
      queryKey: [mode === "image" ? "image-studio" : "video-studio", "providers"],
    });
    setKeyDialog(null);
  }

  if (sorted.length === 0) {
    return (
      <div className={cn("text-xs text-muted-foreground py-2", className)}>
        Loading providers…
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {mode === "image" ? "Image Providers" : "Video Providers"} ·{" "}
          {sorted.length}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={!canScrollLeft}
            onClick={() => scrollBy(-280)}
            aria-label="Scroll providers left"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={!canScrollRight}
            onClick={() => scrollBy(280)}
            aria-label="Scroll providers right"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="flex gap-2 overflow-x-auto snap-x snap-mandatory scrollbar-thin pb-1 -mx-1 px-1"
        style={{ scrollbarWidth: "thin" }}
      >
        {sorted.map((p) => {
          const isSelected = selectedProvider === p.id;
          const currentModel =
            isSelected && selectedModel
              ? p.models.find((m) => m.id === selectedModel)
              : undefined;
          const usableModels = p.models.filter((m) => !m.comingSoon);
          const disabled = !!p.comingSoon;

          return (
            <button
              key={p.id}
              type="button"
              onClick={() => handleCardClick(p)}
              disabled={disabled}
              className={cn(
                "snap-start shrink-0 w-[170px] rounded-md border bg-card text-left p-2 flex flex-col gap-1.5 transition-colors",
                "hover:border-violet-400/60 hover:bg-accent/40",
                isSelected && "border-violet-500 ring-1 ring-violet-500/40 bg-accent/30",
                disabled && "opacity-50 cursor-not-allowed",
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-semibold truncate" title={p.label}>
                  {p.label}
                </span>
                {p.kind === "cloud" && !disabled && (
                  <Button
                    asChild
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 -mr-1 hover:bg-accent"
                    title={p.configured ? "Reconfigure API key" : "Add API key"}
                  >
                    {/* span so the outer button onClick still works for the card */}
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => handleReconfigure(e, p)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          handleReconfigure(
                            e as unknown as React.MouseEvent,
                            p,
                          );
                        }
                      }}
                    >
                      <Settings2 className="h-3 w-3" />
                    </span>
                  </Button>
                )}
              </div>

              <ProviderCarouselBadge provider={p} />

              <div className="text-[10px] text-muted-foreground">
                {usableModels.length} model{usableModels.length === 1 ? "" : "s"}
              </div>
              {currentModel && (
                <div className="text-[10px] text-violet-600 dark:text-violet-400 truncate">
                  ▸ {currentModel.label}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {keyDialog && (
        <ApiKeyInlineDialog
          open
          onOpenChange={(o) => !o && setKeyDialog(null)}
          providerId={keyDialog.providerId}
          providerLabel={keyDialog.providerLabel}
          envVars={keyDialog.envVars}
          website={keyDialog.website}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

function ProviderCarouselBadge({ provider }: { provider: AnyProvider }) {
  if (provider.comingSoon) {
    return (
      <Badge variant="outline" className="text-[9px] px-1 py-0 w-fit">
        <Sparkles className="h-2.5 w-2.5 mr-0.5" />
        Coming soon
      </Badge>
    );
  }
  if (provider.kind === "local") {
    if (provider.health === "ok") {
      return (
        <Badge
          variant="outline"
          className="text-[9px] px-1 py-0 w-fit text-emerald-600 border-emerald-600/40"
        >
          <Wifi className="h-2.5 w-2.5 mr-0.5" />
          Local: online
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className="text-[9px] px-1 py-0 w-fit text-amber-600 border-amber-600/40"
      >
        <WifiOff className="h-2.5 w-2.5 mr-0.5" />
        Local: offline
      </Badge>
    );
  }
  if (provider.configured) {
    return (
      <Badge
        variant="outline"
        className="text-[9px] px-1 py-0 w-fit text-emerald-600 border-emerald-600/40"
      >
        <Check className="h-2.5 w-2.5 mr-0.5" />
        Configured
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[9px] px-1 py-0 w-fit text-amber-600 border-amber-600/40"
    >
      <KeyRound className="h-2.5 w-2.5 mr-0.5" />
      Needs API key
    </Badge>
  );
}
