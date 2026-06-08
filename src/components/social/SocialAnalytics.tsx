/**
 * Analytics tab — own publishing history rollup + live engagement metrics,
 * rendered with dependency-free bars.
 */

import {
  BarChart3,
  Eye,
  Heart,
  Loader2,
  MessageSquare,
  RefreshCw,
  Share2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { showError, showSuccess } from "@/lib/toast";

import {
  useSocialAnalyticsOverview,
  useSyncSocialMetrics,
} from "@/hooks/useSocial";
import { PROVIDER_LABEL, compactNumber } from "./shared";

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-muted/20 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

export function SocialAnalytics() {
  const { data, isLoading } = useSocialAnalyticsOverview();
  const sync = useSyncSocialMetrics();

  const maxImpressions = Math.max(
    1,
    ...(data?.byProvider.map((p) => p.impressions) ?? [1]),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <BarChart3 className="h-5 w-5 text-primary" /> Analytics
          </h2>
          <p className="text-sm text-muted-foreground">
            Publishing history and live engagement metrics.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              const { snapshots } = await sync.mutateAsync(undefined);
              showSuccess(
                snapshots > 0
                  ? `Captured ${snapshots} metric snapshot${snapshots === 1 ? "" : "s"}.`
                  : "No posted content to measure yet.",
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
          Refresh metrics
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              icon={<Eye className="h-3.5 w-3.5" />}
              label="Impressions"
              value={compactNumber(data.metrics.impressions)}
            />
            <StatTile
              icon={<Heart className="h-3.5 w-3.5" />}
              label="Likes"
              value={compactNumber(data.metrics.likes)}
            />
            <StatTile
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              label="Comments"
              value={compactNumber(data.metrics.comments)}
            />
            <StatTile
              icon={<Share2 className="h-3.5 w-3.5" />}
              label="Shares"
              value={compactNumber(data.metrics.shares)}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Post pipeline</CardTitle>
                <CardDescription>
                  {data.posts.total} total post
                  {data.posts.total === 1 ? "" : "s"}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {[
                  ["Posted", data.posts.posted],
                  ["Scheduled", data.posts.scheduled],
                  ["Needs approval", data.posts.needsApproval],
                  ["Drafts", data.posts.drafts],
                  ["Failed", data.posts.failed],
                ].map(([label, value]) => (
                  <div
                    key={label as string}
                    className="flex items-center justify-between"
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium">{value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Impressions by platform</CardTitle>
                <CardDescription>Latest snapshot per post.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.byProvider.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No metrics yet.
                  </p>
                )}
                {data.byProvider.map((p) => (
                  <div key={p.provider}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span>{PROVIDER_LABEL[p.provider]}</span>
                      <span className="text-muted-foreground">
                        {compactNumber(p.impressions)} impressions ·{" "}
                        {p.posted} posted
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{
                          width: `${Math.round((p.impressions / maxImpressions) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Engagement inbox</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-2xl font-semibold">
                  {data.engagements.total}
                </div>
                <div className="text-xs text-muted-foreground">Total</div>
              </div>
              <div>
                <div className="text-2xl font-semibold">
                  {data.engagements.new}
                </div>
                <div className="text-xs text-muted-foreground">New</div>
              </div>
              <div>
                <div className="text-2xl font-semibold">
                  {data.engagements.needsReply}
                </div>
                <div className="text-xs text-muted-foreground">Needs reply</div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
