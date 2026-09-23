import ReactMarkdown from "react-markdown";
import { ClipboardList } from "lucide-react";

/**
 * A plan proposed in Plan mode (`<joy-plan-proposal>`), shown as a card.
 * Approve / Revise / Reject live under the message, in PlanProposalActions,
 * because only the message knows whether it is still the latest one.
 */
export function JoyPlanProposal({
  title,
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}) {
  const body = typeof children === "string" ? children : String(children ?? "");

  return (
    <div className="not-prose my-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <ClipboardList className="h-4 w-4 text-primary" />
        <span>{title || "Plan"}</span>
        <span className="ml-auto text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
          Proposed plan — nothing has changed yet
        </span>
      </div>
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown>{body}</ReactMarkdown>
      </div>
    </div>
  );
}
