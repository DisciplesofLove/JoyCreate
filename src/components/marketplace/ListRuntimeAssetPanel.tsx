/**
 * ListRuntimeAssetPanel — universal "List as Runtime Asset" affordance for any
 * runtime-bearing entity (agent or app). Opens a dialog to collect the target
 * ERC-8004 agentId + optional pricing, then lists the entity as a Licensed
 * Runtime Asset via `useListRuntimeAsset` (ERC-8004 card + A2A economy).
 *
 * This is the on-chain *runtime* rail — distinct from (and complementary to)
 * the JoyMarketplace ERC-1155 publish flow. Existing listings are untouched.
 *
 * Usage:
 *   <ListRuntimeAssetPanel kind="agent" entityId={agent.id} defaultName={agent.name} />
 *   <ListRuntimeAssetPanel kind="app" entityId={app.id} defaultName={app.name} />
 */

import { useState } from "react";
import { Rocket, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useListRuntimeAsset } from "@/hooks/use_list_runtime_asset";

type PricingModel = "free" | "fixed" | "per_token" | "per_call" | "subscription";
type Currency = "USDC" | "JOY" | "TIA" | "MATIC" | "points";

interface Props {
  kind: "agent" | "app";
  /** `agents.id` (kind="agent") or `apps.id` (kind="app"). */
  entityId: number;
  /** Pre-fill the card name (defaults to the entity name on the backend). */
  defaultName?: string;
  /** Pre-fill the ERC-8004 agentId when the entity is already linked on-chain. */
  defaultErc8004AgentId?: string;
  /** Compact icon-only trigger. */
  iconOnly?: boolean;
  triggerLabel?: string;
}

export function ListRuntimeAssetPanel({
  kind,
  entityId,
  defaultName,
  defaultErc8004AgentId,
  iconOnly,
  triggerLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [erc8004AgentId, setErc8004AgentId] = useState(defaultErc8004AgentId ?? "");
  const [cardName, setCardName] = useState(defaultName ?? "");
  const [chain, setChain] = useState<"arbitrumSepolia" | "arbitrumOne">("arbitrumSepolia");
  const [bridgeToA2a, setBridgeToA2a] = useState(true);
  const [pricingModel, setPricingModel] = useState<PricingModel>("per_call");
  const [priceAmount, setPriceAmount] = useState("0");
  const [currency, setCurrency] = useState<Currency>("USDC");

  const listM = useListRuntimeAsset();

  const handleList = () => {
    listM.mutate(
      {
        kind,
        entityId,
        chain,
        erc8004AgentId: erc8004AgentId.trim() || undefined,
        cardName: cardName.trim() || undefined,
        bridgeToA2a,
        pricing:
          pricingModel === "free"
            ? { pricingModel }
            : { pricingModel, priceAmount: priceAmount.trim() || "0", currency },
      },
      { onSuccess: () => setOpen(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={iconOnly ? "icon" : "sm"} variant="outline">
          <Rocket className={iconOnly ? "h-4 w-4" : "mr-2 h-4 w-4"} />
          {!iconOnly && (triggerLabel ?? "List as Runtime Asset")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>List as Runtime Asset</DialogTitle>
          <DialogDescription>
            Publish this {kind} as a Licensed Runtime Asset: its runtime is pinned
            and attached to an ERC-8004 agent card, then mirrored into the A2A
            economy so other agents can discover, quote and invoke it. Existing
            marketplace listings are unaffected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="lra-agent-id">ERC-8004 agent id</Label>
            <Input
              id="lra-agent-id"
              value={erc8004AgentId}
              onChange={(e) => setErc8004AgentId(e.target.value)}
              placeholder="Required unless already linked on-chain"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lra-card-name">Card name</Label>
            <Input
              id="lra-card-name"
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
              placeholder={defaultName ?? "Listing name"}
            />
          </div>
          <div className="space-y-1">
            <Label>Chain</Label>
            <Select value={chain} onValueChange={(v) => setChain(v as typeof chain)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="arbitrumSepolia">Arbitrum Sepolia (testnet)</SelectItem>
                <SelectItem value="arbitrumOne">Arbitrum One (mainnet)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Pricing</Label>
              <Select
                value={pricingModel}
                onValueChange={(v) => setPricingModel(v as PricingModel)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="per_call">Per call</SelectItem>
                  <SelectItem value="per_token">Per token</SelectItem>
                  <SelectItem value="fixed">Fixed</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lra-price">Amount</Label>
              <Input
                id="lra-price"
                type="number"
                min="0"
                step="0.000001"
                value={priceAmount}
                disabled={pricingModel === "free"}
                onChange={(e) => setPriceAmount(e.target.value)}
              />
            </div>
          </div>
          {pricingModel !== "free" && (
            <div className="space-y-1">
              <Label>Currency</Label>
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USDC">USDC</SelectItem>
                  <SelectItem value="JOY">JOY</SelectItem>
                  <SelectItem value="TIA">TIA</SelectItem>
                  <SelectItem value="MATIC">MATIC</SelectItem>
                  <SelectItem value="points">Points</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="lra-bridge">Mirror into A2A economy</Label>
              <p className="text-xs text-muted-foreground">
                Create a discoverable A2A listing other agents can invoke.
              </p>
            </div>
            <Switch id="lra-bridge" checked={bridgeToA2a} onCheckedChange={setBridgeToA2a} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={listM.isPending}>
            Cancel
          </Button>
          <Button onClick={handleList} disabled={listM.isPending}>
            {listM.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Listing…
              </>
            ) : (
              "List"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
