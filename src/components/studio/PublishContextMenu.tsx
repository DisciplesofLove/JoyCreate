/**
 * PublishContextMenu — Phase 1C component.
 *
 * Universal "Publish to Marketplace" affordance that can be mounted on any
 * studio asset card. Opens a dialog to collect price/royalty, then dispatches
 * to the right `studio:publish-*` IPC handler via TanStack Query.
 *
 * Usage:
 *   <PublishContextMenu kind="image" assetId={img.id} defaultName={img.prompt} />
 *   <PublishContextMenu kind="video" assetId={vid.id} />
 *
 * Marketplace items are NEVER lost by this flow — it only enhances
 * monetization by exposing an additional on-chain publishing path.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { IpcClient, type StudioPublishOutcome } from "@/ipc/ipc_client";

export type PublishKind = "image" | "video";

interface Props {
  kind: PublishKind;
  assetId: number;
  defaultName?: string;
  defaultDescription?: string;
  /** Optional render override for the trigger. */
  triggerLabel?: string;
  /** Compact button mode (icon only). */
  iconOnly?: boolean;
}

export function PublishContextMenu({
  kind,
  assetId,
  defaultName,
  defaultDescription,
  triggerLabel,
  iconOnly,
}: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName ?? "");
  const [description, setDescription] = useState(defaultDescription ?? "");
  const [priceUsdcDollars, setPriceUsdcDollars] = useState("0");
  const [royaltyPct, setRoyaltyPct] = useState("2.5");

  const publishM = useMutation({
    mutationFn: async (): Promise<StudioPublishOutcome> => {
      const dollars = Number.parseFloat(priceUsdcDollars);
      const pct = Number.parseFloat(royaltyPct);
      if (!Number.isFinite(dollars) || dollars < 0) {
        throw new Error("Price must be a non-negative number");
      }
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new Error("Royalty must be between 0% and 100%");
      }
      const args = {
        assetId,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        priceUsdc: Math.round(dollars * 1_000_000), // dollars → USDC base units
        royaltyBps: Math.round(pct * 100), // percent → basis points
      };
      const client = IpcClient.getInstance();
      return kind === "image"
        ? client.publishStudioImage(args)
        : client.publishStudioVideo(args);
    },
    onSuccess: (outcome) => {
      if (outcome.ok) {
        toast.success(
          outcome.dryRun
            ? "Dry run complete — gas estimated, no on-chain writes"
            : `Published${outcome.tokenId ? ` (token #${outcome.tokenId})` : ""}`,
        );
        setOpen(false);
      } else {
        toast.error(`Publish failed${outcome.blockedAt ? `: ${outcome.blockedAt}` : ""}`);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={iconOnly ? "icon" : "sm"} variant="outline">
          <Upload className={iconOnly ? "h-4 w-4" : "mr-2 h-4 w-4"} />
          {!iconOnly && (triggerLabel ?? "Publish")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish to Marketplace</DialogTitle>
          <DialogDescription>
            Mint this {kind} as an ERC-1155 on Polygon Amoy and list it on the
            Joy marketplace. Existing listings are unaffected — this only adds
            a new on-chain edition.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="publish-name">Name</Label>
            <Input
              id="publish-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="A short title"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="publish-desc">Description</Label>
            <Textarea
              id="publish-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="publish-price">Price (USDC)</Label>
              <Input
                id="publish-price"
                type="number"
                min="0"
                step="0.01"
                value={priceUsdcDollars}
                onChange={(e) => setPriceUsdcDollars(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="publish-royalty">Royalty (%)</Label>
              <Input
                id="publish-royalty"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={royaltyPct}
                onChange={(e) => setRoyaltyPct(e.target.value)}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={publishM.isPending}>
            Cancel
          </Button>
          <Button onClick={() => publishM.mutate()} disabled={publishM.isPending}>
            {publishM.isPending ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Publishing…</>
            ) : (
              "Publish"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
