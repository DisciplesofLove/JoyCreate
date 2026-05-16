/**
 * UnifiedModelPicker — single grouped picker that exposes EVERY image/video
 * provider+model regardless of whether an API key is currently configured.
 *
 * Each row shows a status badge (Configured / Needs API key / Local: reachable
 * / Local: offline / Coming soon). Selecting a row that needs a key opens the
 * inline ApiKeyInlineDialog so the user never has to leave the studio.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronsUpDown, KeyRound, Wifi, WifiOff, Sparkles, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ImageStudioProvider, VideoStudioProvider } from "@/ipc/ipc_types";
import { ApiKeyInlineDialog } from "./ApiKeyInlineDialog";

export type StudioMode = "image" | "video";

type AnyProvider = ImageStudioProvider | VideoStudioProvider;

interface Props {
  mode: StudioMode;
  providers: AnyProvider[];
  /** Currently selected `${providerId}::${modelId}` key, or empty string. */
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

export function UnifiedModelPicker({
  mode,
  providers,
  selectedProvider,
  selectedModel,
  onSelect,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [keyDialog, setKeyDialog] = useState<KeyDialogTarget | null>(null);
  const queryClient = useQueryClient();

  const flatRows = useMemo(() => {
    return providers.flatMap((p) =>
      p.models.map((m) => ({ provider: p, model: m })),
    );
  }, [providers]);

  const selected = flatRows.find(
    (r) => r.provider.id === selectedProvider && r.model.id === selectedModel,
  );

  function handleRowClick(providerId: string, modelId: string) {
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;
    const model = provider.models.find((m) => m.id === modelId);
    if (!model) return;

    if (model.comingSoon || provider.comingSoon) {
      // Don't select non-functional providers.
      return;
    }

    if (!provider.configured && provider.kind === "cloud") {
      // Open the inline key dialog instead of selecting.
      setKeyDialog({
        providerId: provider.id,
        providerLabel: provider.label,
        envVars: provider.apiKeyEnvVars,
        website: provider.website,
      });
      return;
    }

    if (!provider.configured && provider.kind === "local") {
      // Local server unreachable — still let user pick (so they get a
      // meaningful error when they try to generate) but show a hint.
      onSelect(providerId, modelId);
      setOpen(false);
      return;
    }

    onSelect(providerId, modelId);
    setOpen(false);
  }

  function handleKeyDialogSaved() {
    // Refetch provider list so the picker reflects the new configured state.
    queryClient.invalidateQueries({
      queryKey: [mode === "image" ? "image-studio" : "video-studio", "providers"],
    });
    setKeyDialog(null);
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label className="text-xs">Model</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className="h-9 w-full justify-between text-xs font-normal"
          >
            {selected ? (
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">
                  <span className="text-muted-foreground">{selected.provider.label}:</span>{" "}
                  {selected.model.label}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">Choose a model…</span>
            )}
            <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[420px] p-0" align="start">
          <ScrollArea className="max-h-[420px]">
            <div className="flex flex-col">
              {providers.map((provider) => (
                <ProviderGroup
                  key={provider.id}
                  provider={provider}
                  selectedProviderId={selectedProvider}
                  selectedModelId={selectedModel}
                  onPick={handleRowClick}
                />
              ))}
              {providers.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  Loading providers…
                </div>
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>

      {keyDialog && (
        <ApiKeyInlineDialog
          open
          onOpenChange={(o) => !o && setKeyDialog(null)}
          providerId={keyDialog.providerId}
          providerLabel={keyDialog.providerLabel}
          envVars={keyDialog.envVars}
          website={keyDialog.website}
          onSaved={handleKeyDialogSaved}
        />
      )}
    </div>
  );
}

function ProviderGroup({
  provider,
  selectedProviderId,
  selectedModelId,
  onPick,
}: {
  provider: AnyProvider;
  selectedProviderId: string;
  selectedModelId: string;
  onPick: (providerId: string, modelId: string) => void;
}) {
  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">{provider.label}</span>
          <ProviderStatusBadge provider={provider} />
        </div>
      </div>
      <div className="flex flex-col">
        {provider.models.map((model) => {
          const isSelected =
            selectedProviderId === provider.id && selectedModelId === model.id;
          const disabled = !!(model.comingSoon || provider.comingSoon);
          return (
            <button
              key={model.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(provider.id, model.id)}
              className={cn(
                "flex items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed",
                isSelected && "bg-accent",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                {isSelected ? (
                  <Check className="h-3.5 w-3.5 text-violet-500 shrink-0" />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="truncate">{model.label}</span>
              </span>
              <ModelHint provider={provider} disabled={disabled} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProviderStatusBadge({ provider }: { provider: AnyProvider }) {
  if (provider.comingSoon) {
    return (
      <Badge variant="outline" className="text-[9px] px-1 py-0">
        <Sparkles className="h-2.5 w-2.5 mr-0.5" />
        Coming soon
      </Badge>
    );
  }
  if (provider.kind === "local") {
    if (provider.health === "ok") {
      return (
        <Badge variant="outline" className="text-[9px] px-1 py-0 text-emerald-600 border-emerald-600/40">
          <Wifi className="h-2.5 w-2.5 mr-0.5" />
          Local: online
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-[9px] px-1 py-0 text-amber-600 border-amber-600/40">
        <WifiOff className="h-2.5 w-2.5 mr-0.5" />
        Local: offline
      </Badge>
    );
  }
  if (provider.configured) {
    return (
      <Badge variant="outline" className="text-[9px] px-1 py-0 text-emerald-600 border-emerald-600/40">
        <Check className="h-2.5 w-2.5 mr-0.5" />
        Configured
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[9px] px-1 py-0 text-amber-600 border-amber-600/40">
      <KeyRound className="h-2.5 w-2.5 mr-0.5" />
      Needs API key
    </Badge>
  );
}

function ModelHint({
  provider,
  disabled,
}: {
  provider: AnyProvider;
  disabled: boolean;
}) {
  if (disabled) return <span className="text-[10px] text-muted-foreground">soon</span>;
  if (provider.kind === "cloud" && !provider.configured) {
    return <span className="text-[10px] text-amber-600">Add key →</span>;
  }
  return null;
}
