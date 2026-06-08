/**
 * Overview tab — at-a-glance dashboard: agent status, key counts, quick
 * actions, and the most recent posts.
 */

import {
  CalendarClock,
  CheckCircle2,
  Inbox,
  Loader2,
  MessageSquare,
  Send,
} from "lucide-react";

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
  useSocialAccounts,
  useSocialAgentStatus,
  useSocialPosts,
} from "@/hooks/useSocial";
import type { SocialTab } from "@/pages/social";
import {
  POST_STATUS_LABEL,
  PROVIDER_ACCENT,
  fmtTs,
  postStatusVariant,
  providerInitial,
} from "./shared";

function MetricCard({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-border/40 bg-muted/20 p-4 text-left transition hover:bg-muted/40"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </button>
  );
}

export function SocialOverview({
  onNavigate,
}: {
  onNavigate: (tab: SocialTab) => void;
}) {
  const { data: status } = useSocialAgentStatus();
  const { data: accounts } = useSocialAccounts();
  const { data: recentPosts, isLoading } = useSocialPosts({ limit: 8 });

  const connectedCount = accounts?.length ?? 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Social Manager Agent</CardTitle>
            <CardDescription>
              {status?.enabled
                ? "Active — generating, scheduling and engaging on your behalf."
                : "Paused — you're in full manual control."}
            </CardDescription>
          </div>
          <Badge variant={status?.enabled ? "default" : "outline"}>
            {status?.enabled ? "Running" : "Paused"}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onNavigate("composer")}>
            <Send className="mr-1 h-4 w-4" /> Compose
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate("campaigns")}
          >
            New campaign
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate("agent")}
          >
            Agent settings
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          icon={<CheckCircle2 className="h-3.5 w-3.5" />}
          label="Connected accounts"
          value={connectedCount}
          onClick={() => onNavigate("accounts")}
        />
        <MetricCard
          icon={<CalendarClock className="h-3.5 w-3.5" />}
          label="Scheduled"
          value={status?.scheduledPosts ?? 0}
          onClick={() => onNavigate("calendar")}
        />
        <MetricCard
          icon={<Inbox className="h-3.5 w-3.5" />}
          label="Awaiting approval"
          value={
            (status?.pendingPostApprovals ?? 0) +
            (status?.pendingReplyApprovals ?? 0)
          }
          onClick={() => onNavigate("approvals")}
        />
        <MetricCard
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="New engagements"
          value={status?.newEngagements ?? 0}
          onClick={() => onNavigate("inbox")}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent posts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!isLoading && (recentPosts?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              No posts yet. Head to the composer to create your first.
            </p>
          )}
          {recentPosts?.map((post) => (
            <div
              key={post.id}
              className="flex items-start gap-3 rounded-lg border border-border/40 bg-muted/20 p-3"
            >
              <div className="flex -space-x-1">
                {post.targets.slice(0, 4).map((t) => (
                  <div
                    key={t.id}
                    className={`flex h-6 w-6 items-center justify-center rounded-md border text-[10px] font-semibold ${
                      t.provider
                        ? PROVIDER_ACCENT[t.provider]
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {t.provider ? providerInitial(t.provider) : "?"}
                  </div>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm text-foreground/90">
                  {post.content.text}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtTs(post.scheduledFor ?? post.postedAt ?? post.createdAt)}
                </p>
              </div>
              <Badge
                variant={postStatusVariant(post.status)}
                className="text-[10px]"
              >
                {POST_STATUS_LABEL[post.status]}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
