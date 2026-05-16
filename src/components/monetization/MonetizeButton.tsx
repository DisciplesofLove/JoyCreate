/**
 * MonetizeButton
 *
 * Phase 5 (M2) Monetization: a single, reusable "set up monetization"
 * dialog that any publishable surface (Asset Studio, Blueprints, Agents,
 * Plugins, Workflows) can drop in. Replaces the bespoke price/royalty
 * fields scattered across each publish flow with one consistent UX.
 *
 * The component is presentational — it surfaces the user's monetization
 * intent (model, price, currency, royalty) via `onSubmit`. Persistence
 * is the responsibility of the calling surface, which knows which IPC
 * channel owns the asset (`joy-publish:*`, `agent-builder:update`,
 * `mcp:update-server`, etc.). This intentionally avoids coupling the UI
 * to a single backend so the same button can be used everywhere without
 * cross-domain dependencies.
 *
 * No new IPC channels or handlers are introduced by this component.
 */

import { useState } from "react";
import { CircleDollarSign } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

export type MonetizationModel =
  | "free"
  | "one-time"
  | "subscription"
  | "pay-per-call";

export type MonetizationCurrency = "USD" | "JOY" | "ETH" | "MATIC";

export interface MonetizationConfig {
  model: MonetizationModel;
  /** Decimal price (e.g. "9.99"). Empty when model is "free". */
  price: string;
  currency: MonetizationCurrency;
  /** Royalty percentage 0-100 for secondary sales. */
  royaltyPercent: number;
  /** Subscription billing period; only meaningful when model is "subscription". */
  billingPeriod: "monthly" | "yearly";
}

export const DEFAULT_MONETIZATION: MonetizationConfig = {
  model: "free",
  price: "",
  currency: "USD",
  royaltyPercent: 0,
  billingPeriod: "monthly",
};

export interface MonetizeButtonProps {
  /** Existing config to prefill the dialog with. */
  initial?: MonetizationConfig;
  /** Called when the user clicks "Save". Throws are surfaced as-is. */
  onSubmit: (config: MonetizationConfig) => void | Promise<void>;
  /** Optional human-readable label for the asset being monetized. */
  assetLabel?: string;
  /** Override trigger button visuals. */
  buttonVariant?: ButtonProps["variant"];
  buttonSize?: ButtonProps["size"];
  buttonClassName?: string;
  triggerLabel?: string;
  /** Disable the trigger (e.g. while the parent is saving). */
  disabled?: boolean;
}

const MODELS: Array<{
  value: MonetizationModel;
  label: string;
  description: string;
}> = [
  {
    value: "free",
    label: "Free",
    description: "Anyone can use this asset without paying.",
  },
  {
    value: "one-time",
    label: "One-time",
    description: "Charge once for permanent access.",
  },
  {
    value: "subscription",
    label: "Subscription",
    description: "Recurring monthly or yearly charge.",
  },
  {
    value: "pay-per-call",
    label: "Pay-per-call",
    description:
      "Charge per invocation. Best for agents, plugins, and MCP tools.",
  },
];

export function MonetizeButton({
  initial,
  onSubmit,
  assetLabel,
  buttonVariant = "outline",
  buttonSize = "sm",
  buttonClassName,
  triggerLabel = "Monetize",
  disabled = false,
}: MonetizeButtonProps) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<MonetizationConfig>(
    initial ?? DEFAULT_MONETIZATION,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function patch<K extends keyof MonetizationConfig>(
    key: K,
    value: MonetizationConfig[K],
  ) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  function validate(next: MonetizationConfig): string | null {
    if (next.model === "free") return null;
    const numeric = Number(next.price);
    if (!next.price || Number.isNaN(numeric) || numeric <= 0) {
      return "Enter a price greater than 0.";
    }
    if (next.royaltyPercent < 0 || next.royaltyPercent > 100) {
      return "Royalty must be between 0 and 100.";
    }
    return null;
  }

  async function handleSave() {
    const validationError = validate(config);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSubmit(config);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  const showPriceInput = config.model !== "free";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={buttonVariant}
          size={buttonSize}
          className={buttonClassName}
          disabled={disabled}
        >
          <CircleDollarSign className="mr-2 h-4 w-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Monetize{assetLabel ? `: ${assetLabel}` : ""}</DialogTitle>
          <DialogDescription>
            Pick how buyers pay for this asset. You can change this anytime.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={config.model}
          onValueChange={(value) =>
            patch("model", value as MonetizationModel)
          }
          className="space-y-4"
        >
          <TabsList className="grid w-full grid-cols-4">
            {MODELS.map((model) => (
              <TabsTrigger key={model.value} value={model.value}>
                {model.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {MODELS.map((model) => (
            <TabsContent
              key={model.value}
              value={model.value}
              className="space-y-4"
            >
              <p className="text-sm text-muted-foreground">
                {model.description}
              </p>

              {showPriceInput && model.value === config.model ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="monetize-price">Price</Label>
                    <Input
                      id="monetize-price"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="9.99"
                      value={config.price}
                      onChange={(event) =>
                        patch("price", event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="monetize-currency">Currency</Label>
                    <Select
                      value={config.currency}
                      onValueChange={(value) =>
                        patch("currency", value as MonetizationCurrency)
                      }
                    >
                      <SelectTrigger id="monetize-currency">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD (Stripe)</SelectItem>
                        <SelectItem value="JOY">JOY (token)</SelectItem>
                        <SelectItem value="ETH">ETH</SelectItem>
                        <SelectItem value="MATIC">MATIC</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}

              {model.value === "subscription" &&
              config.model === "subscription" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="monetize-period">Billing period</Label>
                  <Select
                    value={config.billingPeriod}
                    onValueChange={(value) =>
                      patch(
                        "billingPeriod",
                        value as MonetizationConfig["billingPeriod"],
                      )
                    }
                  >
                    <SelectTrigger id="monetize-period">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </TabsContent>
          ))}
        </Tabs>

        <div className="space-y-1.5">
          <Label htmlFor="monetize-royalty">Royalty on resale (%)</Label>
          <Input
            id="monetize-royalty"
            type="number"
            min="0"
            max="100"
            step="0.5"
            value={config.royaltyPercent}
            onChange={(event) =>
              patch(
                "royaltyPercent",
                Number(event.target.value) || 0,
              )
            }
          />
          <p className="text-xs text-muted-foreground">
            Applies to secondary marketplace sales of this asset.
          </p>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save monetization"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
