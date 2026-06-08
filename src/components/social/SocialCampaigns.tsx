/**
 * Campaigns tab — recurring content programs. Spin one up from a natural-
 * language brief (NLP setup), or manage cadence, autonomy toggles and
 * one-off generation.
 */

import {
  CalendarClock,
  Loader2,
  Megaphone,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { SocialCampaignDto } from "@/ipc/handlers/social_content_handlers";
import { showError, showSuccess } from "@/lib/toast";

import {
  useCreateSocialCampaign,
  useDeleteSocialCampaign,
  useGenerateCampaignNow,
  useParseSocialSetup,
  useSocialAccounts,
  useSocialCampaigns,
  useUpdateSocialCampaign,
} from "@/hooks/useSocial";

function CampaignCard({ campaign }: { campaign: SocialCampaignDto }) {
  const update = useUpdateSocialCampaign();
  const remove = useDeleteSocialCampaign();
  const generate = useGenerateCampaignNow();

  return (
    <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{campaign.name}</span>
            <Badge
              variant={campaign.status === "active" ? "default" : "outline"}
              className="text-[10px]"
            >
              {campaign.status}
            </Badge>
          </div>
          {campaign.description && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {campaign.description}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {campaign.topics.map((t) => (
              <Badge key={t} variant="secondary" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
          {campaign.cadence && (
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              {campaign.cadence.frequency} · {campaign.cadence.slots.join(", ")}
            </p>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={async () => {
            try {
              await remove.mutateAsync(campaign.id);
              showSuccess("Campaign deleted.");
            } catch (err) {
              showError(err);
            }
          }}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={campaign.autoGenerate}
            onCheckedChange={(v) =>
              update.mutate({ campaignId: campaign.id, autoGenerate: v })
            }
          />
          Auto-generate
        </label>
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={campaign.autoPublish}
            onCheckedChange={(v) =>
              update.mutate({ campaignId: campaign.id, autoPublish: v })
            }
          />
          Auto-publish
        </label>
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={campaign.status === "active"}
            onCheckedChange={(v) =>
              update.mutate({
                campaignId: campaign.id,
                status: v ? "active" : "paused",
              })
            }
          />
          Active
        </label>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={async () => {
            try {
              const { created } = await generate.mutateAsync({
                campaignId: campaign.id,
              });
              showSuccess(`Generated ${created} draft${created === 1 ? "" : "s"}.`);
            } catch (err) {
              showError(err);
            }
          }}
          disabled={generate.isPending}
        >
          {generate.isPending ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Wand2 className="mr-1 h-3.5 w-3.5" />
          )}
          Generate now
        </Button>
      </div>
    </div>
  );
}

export function SocialCampaigns() {
  const { data: campaigns, isLoading } = useSocialCampaigns();
  const { data: accounts } = useSocialAccounts();
  const parseSetup = useParseSocialSetup();
  const createCampaign = useCreateSocialCampaign();

  const [brief, setBrief] = useState("");

  async function handleCreateFromBrief() {
    if (!brief.trim()) {
      showError("Describe the campaign first.");
      return;
    }
    try {
      const parsed = await parseSetup.mutateAsync(brief.trim());
      const targetAccountIds = (accounts ?? [])
        .filter((a) => parsed.suggestedProviders.includes(a.provider))
        .map((a) => a.id);
      await createCampaign.mutateAsync({
        name: parsed.name,
        description: parsed.description,
        topics: parsed.topics,
        tone: parsed.tone,
        audience: parsed.audience,
        cadence: parsed.cadence,
        targetAccountIds,
        autoGenerate: parsed.autoGenerate,
        autoPublish: parsed.autoPublish,
        status: "active",
      });
      showSuccess(`Campaign "${parsed.name}" created.`);
      setBrief("");
    } catch (err) {
      showError(err);
    }
  }

  const busy = parseSetup.isPending || createCampaign.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Set up with natural
            language
          </CardTitle>
          <CardDescription>
            Describe what you want — e.g. “Post twice a day on weekdays about our
            AI design tool to indie founders on Reddit and LinkedIn, friendly
            tone, draft for my approval.”
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Describe your campaign…"
            className="min-h-[96px]"
          />
          <Button onClick={handleCreateFromBrief} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Megaphone className="mr-1 h-4 w-4" />
            )}
            Create campaign
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
          <CardDescription>
            {campaigns?.length ?? 0} campaign
            {(campaigns?.length ?? 0) === 1 ? "" : "s"}.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!isLoading && (campaigns?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              No campaigns yet. Create one above.
            </p>
          )}
          {campaigns?.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
