/**
 * Composer tab — write or AI-generate a post, attach a generated image, pick
 * target accounts across platforms, then publish now / schedule / save draft.
 */

import { ImagePlus, Loader2, Send, Sparkles, X } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SocialMediaItem, SocialProvider } from "@/db/social_schema";
import { showError, showSuccess } from "@/lib/toast";

import {
  useCreateSocialPost,
  useGenerateSocialDrafts,
  useGenerateSocialImage,
  useImageProviders,
  useSocialAccounts,
} from "@/hooks/useSocial";
import {
  PROVIDER_ACCENT,
  PROVIDER_LABEL,
  fromLocalDatetimeInput,
  providerInitial,
  toLocalDatetimeInput,
} from "./shared";

type Mode = "now" | "schedule" | "draft";

export function SocialComposer() {
  const { data: accounts } = useSocialAccounts();
  const { data: imageProviders } = useImageProviders();
  const generateDrafts = useGenerateSocialDrafts();
  const generateImage = useGenerateSocialImage();
  const createPost = useCreateSocialPost();

  const enabledAccounts = useMemo(
    () => (accounts ?? []).filter((a) => a.enabled),
    [accounts],
  );

  const [text, setText] = useState("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [media, setMedia] = useState<SocialMediaItem[]>([]);

  // AI draft controls
  const [topics, setTopics] = useState("");
  const [tone, setTone] = useState("");

  // Image controls
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageProviderId, setImageProviderId] = useState("");
  const [imageModelId, setImageModelId] = useState("");

  // Publish controls
  const [mode, setMode] = useState<Mode>("now");
  const [whenLocal, setWhenLocal] = useState(
    toLocalDatetimeInput(Date.now() + 60 * 60_000),
  );

  const configuredImageProviders = (imageProviders ?? []).filter(
    (p) => p.configured && !p.comingSoon,
  );
  const activeImageProvider = configuredImageProviders.find(
    (p) => p.id === imageProviderId,
  );

  const primaryProvider: SocialProvider | undefined =
    enabledAccounts.find((a) => selectedAccountIds.includes(a.id))?.provider;

  function toggleAccount(id: number) {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleGenerateDrafts() {
    const topicList = topics
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (topicList.length === 0) {
      showError("Add at least one topic to generate drafts.");
      return;
    }
    try {
      const drafts = await generateDrafts.mutateAsync({
        topics: topicList,
        provider: primaryProvider,
        tone: tone.trim() || undefined,
        count: 1,
        includeImagePrompt: true,
      });
      const draft = drafts[0];
      if (draft) {
        const hashtags = draft.hashtags?.length
          ? `\n\n${draft.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`
          : "";
        setText(`${draft.text}${hashtags}`);
        if (draft.imagePrompt) setImagePrompt(draft.imagePrompt);
        showSuccess("Draft generated.");
      }
    } catch (err) {
      showError(err);
    }
  }

  async function handleGenerateImage() {
    if (!imagePrompt.trim()) {
      showError("Add an image prompt.");
      return;
    }
    if (!activeImageProvider || !imageModelId) {
      showError("Pick an image provider and model.");
      return;
    }
    try {
      const result = await generateImage.mutateAsync({
        prompt: imagePrompt.trim(),
        provider: activeImageProvider.id,
        model: imageModelId,
      });
      setMedia((prev) => [
        ...prev,
        { url: result.filePath, type: "image", altText: imagePrompt.trim() },
      ]);
      showSuccess("Image generated and attached.");
    } catch (err) {
      showError(err);
    }
  }

  async function handleSubmit() {
    if (!text.trim()) {
      showError("Write some post content first.");
      return;
    }
    if (selectedAccountIds.length === 0) {
      showError("Select at least one target account.");
      return;
    }
    const scheduledFor =
      mode === "schedule" ? fromLocalDatetimeInput(whenLocal) : null;
    if (mode === "schedule" && !scheduledFor) {
      showError("Pick a valid schedule date/time.");
      return;
    }
    try {
      await createPost.mutateAsync({
        content: { text: text.trim(), media: media.length ? media : undefined },
        accountIds: selectedAccountIds,
        scheduledFor: mode === "schedule" ? scheduledFor : null,
        status:
          mode === "draft"
            ? "draft"
            : mode === "schedule"
              ? "scheduled"
              : "posted",
        source: "manual",
      });
      showSuccess(
        mode === "now"
          ? "Post published."
          : mode === "schedule"
            ? "Post scheduled."
            : "Draft saved.",
      );
      setText("");
      setMedia([]);
      setSelectedAccountIds([]);
    } catch (err) {
      showError(err);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> AI assist
            </CardTitle>
            <CardDescription>
              Describe topics (comma-separated) and let the agent draft an
              on-brand post for your selected platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Topics</Label>
                <Input
                  value={topics}
                  onChange={(e) => setTopics(e.target.value)}
                  placeholder="product launch, AI tips"
                />
              </div>
              <div className="space-y-1">
                <Label>Tone (optional)</Label>
                <Input
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                  placeholder="friendly, professional…"
                />
              </div>
            </div>
            <Button
              variant="secondary"
              onClick={handleGenerateDrafts}
              disabled={generateDrafts.isPending}
            >
              {generateDrafts.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-4 w-4" />
              )}
              Generate draft
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Post content</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What do you want to share?"
              className="min-h-[160px]"
            />
            <div className="text-right text-xs text-muted-foreground">
              {text.length} characters
            </div>

            {media.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {media.map((m, i) => (
                  <div
                    key={`${m.url}-${i}`}
                    className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 px-2 py-1 text-xs"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    <span className="max-w-[160px] truncate">
                      {m.altText || m.url.split(/[/\\]/).pop()}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setMedia((prev) => prev.filter((_, j) => j !== i))
                      }
                    >
                      <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ImagePlus className="h-4 w-4 text-primary" /> Generate image
              (BYOK)
            </CardTitle>
            <CardDescription>
              Uses your configured image providers from Settings.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              placeholder="A vibrant flat-lay product shot…"
              className="min-h-[72px]"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                value={imageProviderId}
                onValueChange={(v) => {
                  setImageProviderId(v);
                  setImageModelId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Image provider" />
                </SelectTrigger>
                <SelectContent>
                  {configuredImageProviders.length === 0 && (
                    <SelectItem value="__none" disabled>
                      No image providers configured
                    </SelectItem>
                  )}
                  {configuredImageProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={imageModelId}
                onValueChange={setImageModelId}
                disabled={!activeImageProvider}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent>
                  {activeImageProvider?.models
                    .filter((m) => !m.comingSoon)
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="secondary"
              onClick={handleGenerateImage}
              disabled={generateImage.isPending}
            >
              {generateImage.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="mr-1 h-4 w-4" />
              )}
              Generate &amp; attach
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Target accounts</CardTitle>
            <CardDescription>
              Cross-post to multiple platforms at once.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {enabledAccounts.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No enabled accounts. Connect one in the Accounts tab.
              </p>
            )}
            {enabledAccounts.map((account) => {
              const selected = selectedAccountIds.includes(account.id);
              return (
                <button
                  type="button"
                  key={account.id}
                  onClick={() => toggleAccount(account.id)}
                  className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left transition ${
                    selected
                      ? "border-primary/50 bg-primary/10"
                      : "border-border/40 bg-muted/20 hover:bg-muted/40"
                  }`}
                >
                  <div
                    className={`flex h-7 w-7 items-center justify-center rounded-md border text-xs font-semibold ${PROVIDER_ACCENT[account.provider]}`}
                  >
                    {providerInitial(account.provider)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {account.label}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {PROVIDER_LABEL[account.provider]}
                    </div>
                  </div>
                  {selected && (
                    <Badge variant="secondary" className="text-[10px]">
                      Selected
                    </Badge>
                  )}
                </button>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Publish</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="now">Publish now</SelectItem>
                <SelectItem value="schedule">Schedule</SelectItem>
                <SelectItem value="draft">Save as draft</SelectItem>
              </SelectContent>
            </Select>
            {mode === "schedule" && (
              <div className="space-y-1">
                <Label>When</Label>
                <Input
                  type="datetime-local"
                  value={whenLocal}
                  onChange={(e) => setWhenLocal(e.target.value)}
                />
              </div>
            )}
            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={createPost.isPending}
            >
              {createPost.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-1 h-4 w-4" />
              )}
              {mode === "now"
                ? "Publish"
                : mode === "schedule"
                  ? "Schedule"
                  : "Save draft"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
