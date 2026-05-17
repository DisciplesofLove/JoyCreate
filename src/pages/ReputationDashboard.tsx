/**
 * Reputation Dashboard — Phase 4 of the JoyCreate completion plan.
 *
 * Surfaces the lifecycle engine's reputation snapshots that the backend
 * has been recording all along:
 *   - Global leaderboard (top N by overallScore)
 *   - The current user's own snapshot (resolved from settings.joyId)
 *   - Component-score breakdown (creation / verification / usage /
 *     reward / consistency) so creators see what to improve.
 *
 * No new writes: this page is read-only on top of the existing
 * `lifecycle:reputation:*` IPC surface.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSettings } from "@/hooks/useSettings";
import lifecycleClient, {
  type ReputationSnapshot,
  type TrustTier,
} from "@/ipc/lifecycle_client";
import { Trophy, RefreshCw, Award, Flame } from "lucide-react";
import { showError, showSuccess } from "@/lib/toast";

const TIER_STYLES: Record<TrustTier, string> = {
  newcomer: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  contributor: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  trusted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  verified: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  elite: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

function TierBadge({ tier }: { tier: TrustTier }) {
  return (
    <Badge variant="secondary" className={TIER_STYLES[tier]}>
      {tier}
    </Badge>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  if (id.startsWith("0x")) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 1000) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{value}/1000</span>
      </div>
      <Progress value={pct} />
    </div>
  );
}

function MyReputationCard({
  actorId,
  snapshot,
  loading,
  onRecompute,
  recomputing,
}: {
  actorId: string | null;
  snapshot: ReputationSnapshot | null | undefined;
  loading: boolean;
  onRecompute: () => void;
  recomputing: boolean;
}) {
  if (!actorId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your reputation</CardTitle>
          <CardDescription>
            Set up a Joy identity (settings → identity) to start earning a
            reputation score.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your reputation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your reputation</CardTitle>
          <CardDescription>
            No snapshot yet for <span className="font-mono">{shortId(actorId)}</span>.
            Publish, verify, or use an asset to seed your scores.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            size="sm"
            onClick={onRecompute}
            disabled={recomputing}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${recomputing ? "animate-spin" : ""}`} />
            Recompute now
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Award className="h-5 w-5 text-amber-500" />
            Your reputation
            <TierBadge tier={snapshot.tier} />
          </CardTitle>
          <CardDescription>
            <span className="font-mono">{shortId(snapshot.id)}</span> · overall
            score <span className="font-bold text-foreground">{snapshot.overallScore}</span>/1000
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onRecompute} disabled={recomputing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${recomputing ? "animate-spin" : ""}`} />
          Recompute
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ScoreBar label="Creation" value={snapshot.creationScore} />
          <ScoreBar label="Verification" value={snapshot.verificationScore} />
          <ScoreBar label="Usage" value={snapshot.usageScore} />
          <ScoreBar label="Reward" value={snapshot.rewardScore} />
          <ScoreBar label="Consistency" value={snapshot.consistencyScore} />
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Stat label="Assets created" value={snapshot.totalAssetsCreated} />
          <Stat label="Usage events" value={snapshot.totalUsageEvents} />
          <Stat label="Receipts" value={snapshot.totalReceiptsGenerated} />
          <Stat
            label="Streak"
            value={
              <span className="flex items-center gap-1">
                <Flame className="h-4 w-4 text-orange-500" />
                {snapshot.currentStreak}d
              </span>
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-semibold">{value}</div>
    </div>
  );
}

export default function ReputationDashboard() {
  const { settings } = useSettings();
  const actorId = settings?.joyId ?? null;

  const leaderboardQuery = useQuery<ReputationSnapshot[]>({
    queryKey: ["lifecycle", "reputation", "leaderboard"],
    queryFn: () => lifecycleClient.listTopReputation(50),
    staleTime: 30_000,
  });

  const myQuery = useQuery<ReputationSnapshot | null>({
    queryKey: ["lifecycle", "reputation", actorId ?? ""],
    queryFn: () => lifecycleClient.getReputation(actorId!),
    enabled: !!actorId,
    staleTime: 30_000,
  });

  const recompute = async () => {
    if (!actorId) return;
    try {
      await lifecycleClient.recomputeReputation(actorId);
      showSuccess("Reputation recomputed");
      void myQuery.refetch();
      void leaderboardQuery.refetch();
    } catch (err) {
      showError(err);
    }
  };

  const top = leaderboardQuery.data ?? [];

  const myRank = useMemo(() => {
    if (!actorId) return null;
    const idx = top.findIndex((r) => r.id === actorId);
    return idx === -1 ? null : idx + 1;
  }, [top, actorId]);

  return (
    <div className="flex min-h-full w-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reputation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Trust scores derived from creation, verification, usage, rewards, and
          consistency. Top of leaderboard surfaces verified, high-quality
          contributors across the JoyCreate network.
        </p>
      </div>

      <MyReputationCard
        actorId={actorId}
        snapshot={myQuery.data}
        loading={myQuery.isLoading}
        onRecompute={recompute}
        recomputing={myQuery.isFetching}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5 text-amber-500" />
            Global leaderboard
            {myRank ? (
              <Badge variant="outline" className="ml-2">
                You: #{myRank}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            Top {top.length} actors ranked by overall reputation score.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {leaderboardQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : top.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No reputation snapshots yet. Activity from any actor will populate
              this list automatically.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="text-right">Assets</TableHead>
                  <TableHead className="text-right">Streak</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {top.map((row, idx) => (
                  <TableRow
                    key={row.id}
                    className={row.id === actorId ? "bg-primary/5" : undefined}
                  >
                    <TableCell className="font-mono text-muted-foreground">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {shortId(row.id)}
                    </TableCell>
                    <TableCell>
                      <TierBadge tier={row.tier} />
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {row.overallScore}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.totalAssetsCreated}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.currentStreak}d
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
