import { useState } from "react";
import { Check, Loader2, PencilLine, X } from "lucide-react";

import { IpcClient } from "@/ipc/ipc_client";
import { useStreamChat } from "@/hooks/useStreamChat";
import { Button } from "@/components/ui/button";
import { showError } from "@/lib/toast";
import type { PlanAction } from "@/shared/plan_mode";

/**
 * Approve / Revise / Reject for the plan in the latest assistant message.
 *
 * Approve executes the plan in Build mode for one turn, leaving the chat in
 * Plan mode. Revise and Reject stay in Plan mode. The decision itself is the
 * next message in the conversation, so once it is sent this plan is no longer
 * the latest message and the buttons go away.
 */
export function PlanProposalActions({
  chatId,
  messageId,
}: {
  chatId: number;
  messageId: number;
}) {
  const { streamMessage, isStreaming } = useStreamChat();
  const [pending, setPending] = useState<"revise" | "reject" | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const respond = async (action: PlanAction, feedback?: string) => {
    setBusy(true);
    try {
      const result = await IpcClient.getInstance().planRespond({
        chatId,
        messageId,
        action,
        feedback,
      });
      if (result.prompt) {
        await streamMessage({
          prompt: result.prompt,
          chatId,
          chatModeOverride: result.chatModeOverride ?? undefined,
        });
      }
      setPending(null);
      setText("");
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || isStreaming;

  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Review this plan:</span>
        <Button size="sm" className="h-7 gap-1" disabled={disabled} onClick={() => void respond("approve")}>
          {busy && pending === null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve &amp; build
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1"
          disabled={disabled}
          onClick={() => setPending(pending === "revise" ? null : "revise")}
        >
          <PencilLine className="h-3.5 w-3.5" />
          Revise
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-red-600 hover:text-red-700"
          disabled={disabled}
          onClick={() => setPending(pending === "reject" ? null : "reject")}
        >
          <X className="h-3.5 w-3.5" />
          Reject
        </Button>
      </div>

      {pending && (
        <div className="mt-2 space-y-2">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={
              pending === "revise"
                ? "What should change in the plan?"
                : "Why? (optional — helps the next plan)"
            }
            className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7"
              disabled={disabled || (pending === "revise" && !text.trim())}
              onClick={() => void respond(pending, text)}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {pending === "revise" ? "Revise plan" : "Reject plan"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
