/**
 * Inbox tab — unified engagement inbox. Sync inbound comments/mentions/DMs,
 * AI-draft replies, send/approve/dismiss them, and triage status.
 */

import {
  Archive,
  Check,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SocialEngagementStatus } from "@/db/social_schema";
import type { SocialEngagementDto } from "@/ipc/handlers/social_engagement_handlers";
import { showError, showSuccess } from "@/lib/toast";

import {
  useApproveSocialReply,
  useDismissSocialReply,
  useMarkSocialEngagement,
  useSendSocialReply,
  useSocialEngagements,
  useSuggestSocialReply,
  useSyncSocialEngagements,
} from "@/hooks/useSocial";
import { PROVIDER_ACCENT, fmtTs, providerInitial } from "./shared";

const STATUS_FILTERS: Array<{ value: SocialEngagementStatus | "all"; label: string }> =
  [
    { value: "all", label: "All" },
    { value: "new", label: "New" },
    { value: "needs_reply", label: "Needs reply" },
    { value: "replied", label: "Replied" },
    { value: "archived", label: "Archived" },
  ];

function EngagementCard({ engagement }: { engagement: SocialEngagementDto }) {
  const suggest = useSuggestSocialReply();
  const send = useSendSocialReply();
  const approve = useApproveSocialReply();
  const dismiss = useDismissSocialReply();
  const mark = useMarkSocialEngagement();

  const [draft, setDraft] = useState("");

  const pendingReply = engagement.replies.find(
    (r) => r.status === "needs_approval" || r.status === "draft",
  );

  async function handleSuggest() {
    try {
      const { text } = await suggest.mutateAsync({
        engagementId: engagement.id,
      });
      setDraft(text);
    } catch (err) {
      showError(err);
    }
  }

  async function handleSend() {
    if (!draft.trim()) {
      showError("Write or generate a reply first.");
      return;
    }
    try {
      await send.mutateAsync({ engagementId: engagement.id, text: draft.trim() });
      showSuccess("Reply sent.");
      setDraft("");
    } catch (err) {
      showError(err);
    }
  }

  return (
    <div className="rounded-xl border border-border/40 bg-muted/20 p-3">
      <div className="flex items-start gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-xs font-semibold ${
            engagement.provider
              ? PROVIDER_ACCENT[engagement.provider]
              : "bg-muted text-muted-foreground"
          }`}
        >
          {engagement.provider ? providerInitial(engagement.provider) : "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {engagement.authorDisplayName ??
                engagement.authorHandle ??
                "Unknown"}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {engagement.type}
            </Badge>
            {engagement.status === "new" && (
              <Badge variant="secondary" className="text-[10px]">
                New
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {fmtTs(engagement.receivedAt)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/90">
            {engagement.text}
          </p>

          {engagement.replies.length > 0 && (
            <div className="mt-2 space-y-1 border-l-2 border-border/40 pl-3">
              {engagement.replies.map((reply) => (
                <div key={reply.id} className="text-xs">
                  <Badge variant="outline" className="mr-2 text-[9px]">
                    {reply.status}
                  </Badge>
                  <span className="text-foreground/80">{reply.text}</span>
                </div>
              ))}
            </div>
          )}

          {pendingReply ? (
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  try {
                    await approve.mutateAsync(pendingReply.id);
                    showSuccess("Reply approved & sent.");
                  } catch (err) {
                    showError(err);
                  }
                }}
                disabled={approve.isPending}
              >
                <Check className="mr-1 h-3.5 w-3.5" /> Approve &amp; send
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dismiss.mutate(pendingReply.id)}
              >
                <X className="mr-1 h-3.5 w-3.5" /> Dismiss
              </Button>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write a reply, or generate one…"
                className="min-h-[64px] text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleSuggest}
                  disabled={suggest.isPending}
                >
                  {suggest.isPending ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1 h-3.5 w-3.5" />
                  )}
                  Suggest
                </Button>
                <Button
                  size="sm"
                  onClick={handleSend}
                  disabled={send.isPending}
                >
                  {send.isPending ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="mr-1 h-3.5 w-3.5" />
                  )}
                  Send
                </Button>
                {engagement.status !== "archived" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      mark.mutate({
                        engagementId: engagement.id,
                        status: "archived",
                      })
                    }
                  >
                    <Archive className="mr-1 h-3.5 w-3.5" /> Archive
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SocialInbox() {
  const [status, setStatus] = useState<SocialEngagementStatus | "all">("all");
  const sync = useSyncSocialEngagements();
  const { data: engagements, isLoading } = useSocialEngagements(
    status === "all" ? undefined : { status },
  );

  const sorted = useMemo(
    () =>
      [...(engagements ?? [])].sort((a, b) => b.receivedAt - a.receivedAt),
    [engagements],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-primary" /> Engagement inbox
          </CardTitle>
          <CardDescription>
            Reply to comments, mentions and DMs across platforms.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={status}
            onValueChange={(v) =>
              setStatus(v as SocialEngagementStatus | "all")
            }
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const { inserted } = await sync.mutateAsync(undefined);
                showSuccess(
                  inserted > 0
                    ? `${inserted} new item${inserted === 1 ? "" : "s"}.`
                    : "Inbox up to date.",
                );
              } catch (err) {
                showError(err);
              }
            }}
            disabled={sync.isPending}
          >
            {sync.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            Sync
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && sorted.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No engagements yet. Hit Sync to pull from connected accounts.
          </p>
        )}
        {sorted.map((engagement) => (
          <EngagementCard key={engagement.id} engagement={engagement} />
        ))}
      </CardContent>
    </Card>
  );
}
