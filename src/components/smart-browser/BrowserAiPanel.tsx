/**
 * BrowserAiPanel — AI sidebar for the Smart Browser.
 *
 * Better than Edge's Copilot sidebar: local-first (Ollama by default),
 * grounded in the *actual* DOM text of the page currently in the
 * <webview>, with one-tap quick actions (Summarize, Key Points,
 * Explain Like I'm 5, Translate, Fact-check, Ask).
 *
 * The panel hooks the existing `useJoyAssistant` streaming pipeline so
 * it inherits model selection (auto/local/cloud), persistence, and
 * tool calling without re-implementing any of it.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Send, Square, Trash2, Wand2, Languages, FileText, ListChecks, Baby, ShieldCheck, Quote } from "lucide-react";
import { useJoyAssistant } from "@/hooks/useJoyAssistant";
import type { AssistantPageContext } from "@/types/joy_assistant_types";
import { cn } from "@/lib/utils";

export interface PageSnapshot {
  url: string;
  title: string;
  /** Plain-text body, already truncated to a safe length. */
  text: string;
}

interface QuickAction {
  id: string;
  label: string;
  icon: React.ElementType;
  prompt: (snap: PageSnapshot) => string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "summarize",
    label: "Summarize",
    icon: FileText,
    prompt: (s) =>
      `Summarize this page in 4-6 short bullet points. Keep it factual and grounded only in the text below; do not invent anything.\n\nURL: ${s.url}\nTitle: ${s.title}\n\n---\n${s.text}`,
  },
  {
    id: "keypoints",
    label: "Key points",
    icon: ListChecks,
    prompt: (s) =>
      `Extract the 5 most important takeaways from this page as a numbered list. Each point should be one sentence.\n\nURL: ${s.url}\nTitle: ${s.title}\n\n---\n${s.text}`,
  },
  {
    id: "eli5",
    label: "Explain (ELI5)",
    icon: Baby,
    prompt: (s) =>
      `Explain what this page is about as if I am a curious 12-year-old. Avoid jargon. End with one sentence about why it matters.\n\nURL: ${s.url}\nTitle: ${s.title}\n\n---\n${s.text}`,
  },
  {
    id: "translate",
    label: "Translate to English",
    icon: Languages,
    prompt: (s) =>
      `Translate the readable content of this page to fluent English. Preserve headings and list structure. Skip navigation/footer boilerplate.\n\n---\n${s.text}`,
  },
  {
    id: "factcheck",
    label: "Fact-check",
    icon: ShieldCheck,
    prompt: (s) =>
      `Identify any claims on this page that should be verified. For each one, give the exact quote and what would need to be checked. If everything looks routine, say so.\n\nURL: ${s.url}\n\n---\n${s.text}`,
  },
  {
    id: "quotes",
    label: "Pull quotes",
    icon: Quote,
    prompt: (s) =>
      `Pull 3 of the most quotable, self-contained sentences from this page verbatim. Format as a markdown list.\n\n---\n${s.text}`,
  },
];

/** Cap page text to ~32k chars so prompts stay under typical 8k-token windows. */
const MAX_PAGE_CHARS = 32_000;

interface Props {
  /**
   * Async callback that pulls the current visible page text from the
   * webview. Implemented by SmartBrowserPage via `wv.executeJavaScript`.
   */
  getPageSnapshot: () => Promise<PageSnapshot | null>;
}

export function BrowserAiPanel({ getPageSnapshot }: Props) {
  // One persisted assistant session per browser surface.
  const sessionId = "smart-browser";
  const { messages, streaming, sendMessage, cancel, clearHistory } =
    useJoyAssistant(sessionId);

  const [input, setInput] = useState("");
  const [snapshotErr, setSnapshotErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Minimal page context — the AssistantPageContext shape is meant for
  // the rest of the app's UI hints; we route the actual page TEXT inside
  // the user message itself so the model can ground answers.
  const pageContext: AssistantPageContext = useMemo(
    () => ({
      route: "/smart-browser",
      pageTitle: "Smart Browser",
      availableElements: [],
    }),
    [],
  );

  const truncate = useCallback((s: PageSnapshot): PageSnapshot => {
    if (s.text.length <= MAX_PAGE_CHARS) return s;
    return {
      ...s,
      text: `${s.text.slice(0, MAX_PAGE_CHARS)}\n\n[…truncated, ${s.text.length - MAX_PAGE_CHARS} chars omitted]`,
    };
  }, []);

  const runQuickAction = useCallback(
    async (action: QuickAction) => {
      setSnapshotErr(null);
      const snap = await getPageSnapshot().catch(() => null);
      if (!snap || !snap.text.trim()) {
        setSnapshotErr(
          "Couldn't read the page yet. Wait for it to load and try again.",
        );
        return;
      }
      const prompt = action.prompt(truncate(snap));
      sendMessage(prompt, pageContext);
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      });
    },
    [getPageSnapshot, sendMessage, pageContext, truncate],
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const q = input.trim();
      if (!q || streaming) return;
      setSnapshotErr(null);
      const snap = await getPageSnapshot().catch(() => null);
      // For freeform questions we always include page context so the
      // model can answer from the page even when the question doesn't
      // explicitly reference it.
      const prompt = snap?.text?.trim()
        ? `Use the page below as primary context. If the answer isn't in the page, say so plainly.\n\nQuestion: ${q}\n\n---\nURL: ${snap.url}\nTitle: ${snap.title}\n\n${truncate(snap).text}`
        : q;
      sendMessage(prompt, pageContext);
      setInput("");
    },
    [input, streaming, getPageSnapshot, sendMessage, pageContext, truncate],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-border/50 bg-background/95 backdrop-blur flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-500" />
        <span className="font-semibold text-sm">Joy Browse AI</span>
        <Badge variant="secondary" className="text-[10px] ml-1">
          local-first
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          {streaming ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={cancel}
              title="Stop generating"
            >
              <Square className="h-3.5 w-3.5 text-red-500" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => clearHistory()}
            title="Clear chat"
          >
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="px-3 py-2 border-b border-border/40 grid grid-cols-2 gap-1.5">
        {QUICK_ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <button
              key={a.id}
              type="button"
              disabled={streaming}
              onClick={() => runQuickAction(a)}
              className={cn(
                "flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md border border-border/50 bg-muted/30 hover:bg-muted hover:border-primary/40 hover:text-foreground transition-colors text-muted-foreground text-left",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <Icon className="h-3 w-3 shrink-0 text-violet-500" />
              <span className="truncate">{a.label}</span>
            </button>
          );
        })}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center mt-8 space-y-2">
            <Wand2 className="h-6 w-6 mx-auto text-violet-500/60" />
            <p>
              Ask anything about the page in front of you. Pick a quick
              action above, or type a question below.
            </p>
            <p className="text-[10px] opacity-70">
              Runs on your local Llama by default — no page contents leave
              your machine unless you switch to a cloud model.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                m.role === "user"
                  ? "bg-primary/10 border border-primary/20 ml-6"
                  : "bg-muted/40 border border-border/50 mr-6",
              )}
            >
              <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">
                {m.role === "user" ? "You" : "Joy AI"}
              </div>
              {m.content || (
                <span className="text-muted-foreground italic">
                  Thinking…
                </span>
              )}
            </div>
          ))
        )}
        {snapshotErr && (
          <div className="text-xs text-amber-600 dark:text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-2 py-1.5">
            {snapshotErr}
          </div>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={onSubmit}
        className="border-t border-border/50 p-2 flex items-center gap-2 bg-background"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={streaming ? "Generating…" : "Ask about this page…"}
          disabled={streaming}
          className="h-8 text-sm"
          spellCheck={false}
        />
        <Button
          type="submit"
          size="icon"
          variant="default"
          className="h-8 w-8 shrink-0"
          disabled={streaming || !input.trim()}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>
    </div>
  );
}
