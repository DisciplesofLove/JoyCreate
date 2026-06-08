/**
 * Agent tab — configure the autonomous Social Manager: master switch, autonomy
 * toggles (generate / publish / reply), brand voice, daily caps, scan cadence,
 * plus live status and a manual run trigger.
 */

import { Bot, Loader2, Play, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { showError, showSuccess } from "@/lib/toast";

import {
  useRunSocialAgentNow,
  useSetSocialAgentSettings,
  useSocialAgentSettings,
  useSocialAgentStatus,
} from "@/hooks/useSocial";

export function SocialAgentPanel() {
  const { data: settings, isLoading } = useSocialAgentSettings();
  const { data: status } = useSocialAgentStatus();
  const save = useSetSocialAgentSettings();
  const runNow = useRunSocialAgentNow();

  const [brandVoice, setBrandVoice] = useState("");
  const [defaultTone, setDefaultTone] = useState("");
  const [scanCron, setScanCron] = useState("");
  const [maxPosts, setMaxPosts] = useState("10");
  const [maxReplies, setMaxReplies] = useState("50");

  useEffect(() => {
    if (settings) {
      setBrandVoice(settings.brandVoice ?? "");
      setDefaultTone(settings.defaultTone ?? "");
      setScanCron(settings.engagementScanCron ?? "");
      setMaxPosts(String(settings.maxPostsPerDay));
      setMaxReplies(String(settings.maxRepliesPerDay));
    }
  }, [settings]);

  async function toggle(
    key: "enabled" | "autoGenerate" | "autoPublish" | "autoReply",
    value: boolean,
  ) {
    try {
      await save.mutateAsync({ [key]: value });
    } catch (err) {
      showError(err);
    }
  }

  async function handleSaveText() {
    try {
      await save.mutateAsync({
        brandVoice: brandVoice.trim() || null,
        defaultTone: defaultTone.trim() || null,
        engagementScanCron: scanCron.trim() || null,
        maxPostsPerDay: Number.parseInt(maxPosts, 10) || 0,
        maxRepliesPerDay: Number.parseInt(maxReplies, 10) || 0,
      });
      showSuccess("Agent settings saved.");
    } catch (err) {
      showError(err);
    }
  }

  if (isLoading || !settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" /> Autonomy
            </CardTitle>
            <CardDescription>
              Human-in-the-loop by default. Turn on individual automations to let
              the agent act without approval.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center justify-between">
              <div>
                <div className="font-medium">Master switch</div>
                <div className="text-xs text-muted-foreground">
                  Enables scheduled scans and autonomous actions.
                </div>
              </div>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(v) => toggle("enabled", v)}
              />
            </label>
            <label className="flex items-center justify-between">
              <div>
                <div className="font-medium">Auto-generate</div>
                <div className="text-xs text-muted-foreground">
                  Draft posts for active campaigns automatically.
                </div>
              </div>
              <Switch
                checked={settings.autoGenerate}
                onCheckedChange={(v) => toggle("autoGenerate", v)}
              />
            </label>
            <label className="flex items-center justify-between">
              <div>
                <div className="font-medium">Auto-publish</div>
                <div className="text-xs text-muted-foreground">
                  Publish generated posts without approval.
                </div>
              </div>
              <Switch
                checked={settings.autoPublish}
                onCheckedChange={(v) => toggle("autoPublish", v)}
              />
            </label>
            <label className="flex items-center justify-between">
              <div>
                <div className="font-medium">Auto-reply</div>
                <div className="text-xs text-muted-foreground">
                  Reply to inbound engagements on auto-reply accounts.
                </div>
              </div>
              <Switch
                checked={settings.autoReply}
                onCheckedChange={(v) => toggle("autoReply", v)}
              />
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Voice &amp; limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label>Brand voice</Label>
              <Textarea
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
                placeholder="How should the agent sound? Values, do's and don'ts…"
                className="min-h-[80px]"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Default tone</Label>
                <Input
                  value={defaultTone}
                  onChange={(e) => setDefaultTone(e.target.value)}
                  placeholder="friendly, expert…"
                />
              </div>
              <div className="space-y-1">
                <Label>Engagement scan (cron)</Label>
                <Input
                  value={scanCron}
                  onChange={(e) => setScanCron(e.target.value)}
                  placeholder="*/30 * * * *"
                />
              </div>
              <div className="space-y-1">
                <Label>Max posts / day</Label>
                <Input
                  type="number"
                  min={0}
                  value={maxPosts}
                  onChange={(e) => setMaxPosts(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Max replies / day</Label>
                <Input
                  type="number"
                  min={0}
                  value={maxReplies}
                  onChange={(e) => setMaxReplies(e.target.value)}
                />
              </div>
            </div>
            <Button onClick={handleSaveText} disabled={save.isPending}>
              {save.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1 h-4 w-4" />
              )}
              Save settings
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Agent</span>
              <Badge variant={settings.enabled ? "default" : "outline"}>
                {settings.enabled ? "Running" : "Paused"}
              </Badge>
            </div>
            {status && (
              <>
                <Row label="Active campaigns" value={status.activeCampaigns} />
                <Row label="Scheduled posts" value={status.scheduledPosts} />
                <Row
                  label="Posts awaiting approval"
                  value={status.pendingPostApprovals}
                />
                <Row
                  label="Replies awaiting approval"
                  value={status.pendingReplyApprovals}
                />
                <Row label="New engagements" value={status.newEngagements} />
              </>
            )}
            <Button
              className="w-full"
              variant="secondary"
              onClick={async () => {
                try {
                  const r = await runNow.mutateAsync();
                  showSuccess(
                    `Generated ${r.generated}, synced ${r.engagements}, replies ${r.repliesSent}.`,
                  );
                } catch (err) {
                  showError(err);
                }
              }}
              disabled={runNow.isPending}
            >
              {runNow.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-1 h-4 w-4" />
              )}
              Run agent now
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
