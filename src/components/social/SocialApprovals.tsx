/**
 * Approvals tab — review agent/AI-drafted posts awaiting sign-off. Approve to
 * publish (or schedule) or reject to cancel.
 */

import { Check, Clock, Loader2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
  useApproveSocialPost,
  useRejectSocialPost,
  useSocialPosts,
} from "@/hooks/useSocial";
import {
  PROVIDER_ACCENT,
  PROVIDER_LABEL,
  fmtTs,
  providerInitial,
} from "./shared";

export function SocialApprovals() {
  const { data: posts, isLoading } = useSocialPosts({
    status: "needs_approval",
  });
  const approve = useApproveSocialPost();
  const reject = useRejectSocialPost();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending approvals</CardTitle>
        <CardDescription>
          AI and agent-drafted posts waiting for your review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {!isLoading && (posts?.length ?? 0) === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing to approve. You're all caught up.
          </p>
        )}
        {posts?.map((post) => (
          <div
            key={post.id}
            className="rounded-xl border border-border/40 bg-muted/20 p-4"
          >
            <div className="flex items-center gap-2">
              {post.source === "agent" || post.source === "ai" ? (
                <Badge variant="secondary" className="text-[10px]">
                  {post.source === "agent" ? "Agent" : "AI"}
                </Badge>
              ) : null}
              {post.scheduledFor && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" /> {fmtTs(post.scheduledFor)}
                </span>
              )}
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground/90">
              {post.content.text}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {post.targets.map((t) => (
                <div
                  key={t.id}
                  className={`flex h-6 w-6 items-center justify-center rounded-md border text-[10px] font-semibold ${
                    t.provider
                      ? PROVIDER_ACCENT[t.provider]
                      : "bg-muted text-muted-foreground"
                  }`}
                  title={t.provider ? PROVIDER_LABEL[t.provider] : undefined}
                >
                  {t.provider ? providerInitial(t.provider) : "?"}
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await approve.mutateAsync(post.id);
                    showSuccess(
                      post.scheduledFor ? "Approved & scheduled." : "Approved & published.",
                    );
                  } catch (err) {
                    showError(err);
                  }
                }}
                disabled={approve.isPending}
              >
                <Check className="mr-1 h-3.5 w-3.5" /> Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await reject.mutateAsync(post.id);
                    showSuccess("Post rejected.");
                  } catch (err) {
                    showError(err);
                  }
                }}
                disabled={reject.isPending}
              >
                <X className="mr-1 h-3.5 w-3.5" /> Reject
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
