/**
 * Inline API-key dialog used by `UnifiedModelPicker`. Writes to
 * `providerSettings[providerId].apiKey.value` via the existing
 * `set-user-settings` channel. The main process encrypts the value before
 * persisting, and `resolveApiKey` already reads from this location as part of
 * its resolution chain (Vault → User Settings → env vars).
 */

import { useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerLabel: string;
  envVars?: string[];
  website?: string;
  onSaved: () => void;
}

export function ApiKeyInlineDialog({
  open,
  onOpenChange,
  providerId,
  providerLabel,
  envVars,
  website,
  onSaved,
}: Props) {
  const { settings, updateSettings } = useSettings();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Please paste your API key");
      return;
    }
    setSaving(true);
    try {
      const existingProviders = settings?.providerSettings ?? {};
      const existingProvider = existingProviders[providerId] ?? {};
      await updateSettings({
        providerSettings: {
          ...existingProviders,
          [providerId]: {
            ...existingProvider,
            apiKey: { value: trimmed },
          },
        },
      });
      toast.success(`${providerLabel} API key saved`);
      onSaved();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save API key",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add {providerLabel} API key</DialogTitle>
          <DialogDescription>
            Your key is encrypted and stored locally. It is only sent to{" "}
            {providerLabel} when you generate.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`apikey-${providerId}`} className="text-xs">
              API key
            </Label>
            <Input
              id={`apikey-${providerId}`}
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !saving) {
                  e.preventDefault();
                  handleSave();
                }
              }}
            />
          </div>

          {envVars && envVars.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Recognised env vars:{" "}
              <code className="text-[10px]">{envVars.join(", ")}</code>
            </p>
          )}

          {website && (
            <a
              href={website}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-violet-500 hover:underline"
            >
              Get an API key <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !value.trim()}>
            {saving ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save key"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
