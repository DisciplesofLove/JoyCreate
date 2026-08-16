import React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Brain } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";

type ReasoningEffort = "low" | "medium" | "high" | "ultra";

interface EffortOption {
  value: ReasoningEffort;
  label: string;
  description: string;
}

const EFFORT_OPTIONS: EffortOption[] = [
  {
    value: "low",
    label: "Low",
    description: "Fastest and cheapest — minimal reasoning tokens.",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced reasoning for most conversations.",
  },
  {
    value: "high",
    label: "High",
    description: "Extended reasoning for complex problems.",
  },
  {
    value: "ultra",
    label: "Ultra",
    description: "Maximum reasoning — slowest, most thorough.",
  },
];

const DEFAULT_EFFORT: ReasoningEffort = "medium";

function useReasoningEffort() {
  const { settings, updateSettings } = useSettings();

  const effort: ReasoningEffort =
    (settings?.reasoningEffort as ReasoningEffort | undefined) ??
    (settings?.thinkingBudget as ReasoningEffort | undefined) ??
    DEFAULT_EFFORT;

  const temperatureOverride = settings?.temperatureOverride;

  const setEffort = (value: ReasoningEffort) => {
    // Keep the legacy `thinkingBudget` in sync for backward compatibility with
    // any consumers that still read it (the backend prefers `reasoningEffort`).
    updateSettings({
      reasoningEffort: value,
      thinkingBudget: value === "ultra" ? "high" : value,
    });
  };

  const setTemperature = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      updateSettings({ temperatureOverride: null });
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2) {
      updateSettings({ temperatureOverride: parsed });
    }
  };

  return { effort, temperatureOverride, setEffort, setTemperature };
}

/**
 * Shared configuration body: reasoning effort presets + advanced temperature
 * override. Used by both the compact (chat input) and inline (settings) forms.
 */
function ReasoningEffortControls() {
  const { effort, temperatureOverride, setEffort, setTemperature } =
    useReasoningEffort();

  const currentOption =
    EFFORT_OPTIONS.find((o) => o.value === effort) ?? EFFORT_OPTIONS[1];

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="reasoning-effort" className="text-sm font-medium">
          Reasoning Effort
        </Label>
        <Select
          value={effort}
          onValueChange={(v) => setEffort(v as ReasoningEffort)}
        >
          <SelectTrigger className="w-full" id="reasoning-effort">
            <SelectValue placeholder="Select effort" />
          </SelectTrigger>
          <SelectContent>
            {EFFORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {currentOption.description}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="temperature-override" className="text-sm font-medium">
          Temperature{" "}
          <span className="font-normal text-muted-foreground">(advanced)</span>
        </Label>
        <Input
          id="temperature-override"
          type="number"
          min={0}
          max={2}
          step={0.1}
          placeholder="Auto (model default)"
          defaultValue={
            typeof temperatureOverride === "number" ? temperatureOverride : ""
          }
          onBlur={(e) => setTemperature(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setTemperature((e.target as HTMLInputElement).value);
            }
          }}
        />
        <p className="text-xs text-muted-foreground">
          Overrides the model default (0–2). Leave blank for Auto. Use this if a
          model rejects its default temperature.
        </p>
      </div>
    </div>
  );
}

/**
 * Reasoning-effort control.
 *
 * - `variant="compact"` (default): a small button that opens a popover.
 *   Intended for the chat input controls row (per-chat access).
 * - `variant="inline"`: renders the controls directly (for the settings page).
 *
 * All variants read/write the same global settings, so changing the effort in
 * the chat input is reflected in settings and vice-versa.
 */
export function ReasoningEffortSelector({
  variant = "compact",
}: {
  variant?: "compact" | "inline";
}) {
  const { effort } = useReasoningEffort();

  if (variant === "inline") {
    return <ReasoningEffortControls />;
  }

  const currentLabel =
    EFFORT_OPTIONS.find((o) => o.value === effort)?.label ?? "Medium";

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="has-[>svg]:px-1.5 flex items-center gap-1.5 h-8"
            >
              <Brain className="h-4 w-4" />
              <span className="text-xs-sm font-medium">{currentLabel}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Reasoning effort &amp; temperature</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-72">
        <div className="space-y-1 mb-3">
          <h4 className="font-medium flex items-center gap-1.5">
            <Brain className="h-4 w-4" />
            Reasoning
          </h4>
          <div className="h-px bg-border" />
        </div>
        <ReasoningEffortControls />
      </PopoverContent>
    </Popover>
  );
}
