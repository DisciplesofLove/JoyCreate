/**
 * Social posting page.
 *
 * Three areas:
 *   - Connected accounts list with connect / disconnect.
 *   - Composer for posting now or scheduling for later.
 *   - Scheduled post queue with a Cancel action.
 */

import { useMemo, useState } from "react";
import { Loader2, Plus, Send, Trash2, X, Clock } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  useCancelScheduledSocialPost,
  useConnectSocialAccount,
  useDisconnectSocialAccount,
  usePostSocial,
  useScheduledSocialPosts,
  useScheduleSocialPost,
  useSocialAccounts,
  useSocialProviders,
} from "@/hooks/useSocial";
import type { SocialProvider } from "@/db/social_schema";

const PROVIDER_LABEL: Record<SocialProvider, string> = {
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
};

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString();
}

function toLocalDatetimeInput(ms: number): string {
  const d = new Date(ms);
  // YYYY-MM-DDTHH:MM in local tz
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SocialPage() {
  const { data: providers } = useSocialProviders();
  const { data: accounts, isLoading: accountsLoading } = useSocialAccounts();
  const { data: scheduled, isLoading: scheduledLoading } =
    useScheduledSocialPosts();
  const connectMut = useConnectSocialAccount();
  const disconnectMut = useDisconnectSocialAccount();
  const postMut = usePostSocial();
  const scheduleMut = useScheduleSocialPost();
  const cancelMut = useCancelScheduledSocialPost();

  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(
    null,
  );
  const [text, setText] = useState("");
  const [whenLocal, setWhenLocal] = useState<string>(
    toLocalDatetimeInput(Date.now() + 60 * 60_000),
  );
  const [error, setError] = useState<string | null>(null);

  const activeAccount = useMemo(
    () => accounts?.find((a) => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  );

  async function handleConnect(provider: SocialProvider) {
    setError(null);
    try {
      await connectMut.mutateAsync({ provider });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDisconnect(id: number) {
    if (!confirm("Disconnect this account?")) return;
    await disconnectMut.mutateAsync(id);
    if (selectedAccountId === id) setSelectedAccountId(null);
  }

  async function handlePostNow() {
    if (!activeAccount) return;
    setError(null);
    try {
      await postMut.mutateAsync({
        accountId: activeAccount.id,
        payload: { text },
      });
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSchedule() {
    if (!activeAccount) return;
    const ms = new Date(whenLocal).getTime();
    if (Number.isNaN(ms) || ms <= Date.now()) {
      setError("Pick a future date / time.");
      return;
    }
    setError(null);
    try {
      await scheduleMut.mutateAsync({
        accountId: activeAccount.id,
        payload: { text },
        scheduledFor: ms,
      });
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-background px-6 py-4">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Send className="h-6 w-6 text-sky-500" />
          Social
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your accounts, post now, or schedule for later.
        </p>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          {error && (
            <Card className="border-destructive/40 bg-destructive/5">
              <CardContent className="flex items-center justify-between gap-4 py-3 text-sm text-destructive">
                <span>{error}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setError(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Connected accounts</CardTitle>
              <CardDescription>
                Click a provider to connect. Real OAuth flows ship in a later
                release \u2014 for now, providers without API credentials report a
                clear error.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {(providers ?? []).map((p) => (
                  <Button
                    key={p}
                    variant="outline"
                    size="sm"
                    disabled={connectMut.isPending}
                    onClick={() => handleConnect(p)}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Connect {PROVIDER_LABEL[p] ?? p}
                  </Button>
                ))}
              </div>

              {accountsLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading accounts\u2026
                </div>
              )}
              {accounts && accounts.length === 0 && !accountsLoading && (
                <p className="text-sm text-muted-foreground">
                  No accounts connected yet.
                </p>
              )}
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {accounts?.map((acc) => {
                  const selected = acc.id === selectedAccountId;
                  return (
                    <button
                      key={acc.id}
                      onClick={() => setSelectedAccountId(acc.id)}
                      className={`flex items-start justify-between rounded-md border px-3 py-2 text-left ${
                        selected
                          ? "border-sky-500 bg-sky-500/10"
                          : "border-input hover:bg-muted"
                      }`}
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">
                            {PROVIDER_LABEL[acc.provider] ?? acc.provider}
                          </Badge>
                          <span className="font-medium text-sm">
                            {acc.label}
                          </span>
                        </div>
                        {acc.handle && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {acc.handle}
                          </p>
                        )}
                      </div>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDisconnect(acc.id);
                        }}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Compose</CardTitle>
              <CardDescription>
                {activeAccount
                  ? `Posting as ${activeAccount.label}.`
                  : "Select an account above to compose a post."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="What do you want to say?"
                disabled={!activeAccount}
              />
              <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                <div className="space-y-2">
                  <Label htmlFor="social-when">Schedule for</Label>
                  <Input
                    id="social-when"
                    type="datetime-local"
                    value={whenLocal}
                    onChange={(e) => setWhenLocal(e.target.value)}
                    disabled={!activeAccount}
                    className="w-64"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={
                      !activeAccount || text.trim().length === 0 || scheduleMut.isPending
                    }
                    onClick={handleSchedule}
                  >
                    {scheduleMut.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Clock className="mr-2 h-4 w-4" />
                    )}
                    Schedule
                  </Button>
                  <Button
                    disabled={
                      !activeAccount || text.trim().length === 0 || postMut.isPending
                    }
                    onClick={handlePostNow}
                  >
                    {postMut.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    Post now
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Scheduled queue</CardTitle>
              <CardDescription>
                Upcoming + recent posts across all accounts.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {scheduledLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading queue\u2026
                </div>
              )}
              {scheduled && scheduled.length === 0 && !scheduledLoading && (
                <p className="text-sm text-muted-foreground">
                  Nothing scheduled yet.
                </p>
              )}
              <ul className="divide-y">
                {scheduled?.map((post) => (
                  <li
                    key={post.id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            post.status === "pending"
                              ? "secondary"
                              : post.status === "posted"
                                ? "default"
                                : post.status === "failed"
                                  ? "destructive"
                                  : "outline"
                          }
                        >
                          {post.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {fmtTs(post.scheduledFor)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm">
                        {post.payload.text}
                      </p>
                      {post.errorMessage && (
                        <p className="mt-1 text-xs text-destructive">
                          {post.errorMessage}
                        </p>
                      )}
                    </div>
                    {post.status === "pending" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancelMut.mutate(post.id)}
                        disabled={cancelMut.isPending}
                      >
                        Cancel
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
