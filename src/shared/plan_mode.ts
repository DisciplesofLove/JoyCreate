/**
 * Plan mode: propose → review → approve / reject / revise.
 *
 * In Plan mode the model writes a plan wrapped in `<joy-plan-proposal>` and
 * changes nothing. The user then decides:
 *
 *   approve — the plan is executed in Build mode for exactly one turn, without
 *             changing the chat's own mode;
 *   revise  — the model rewrites the plan from the user's feedback, still in
 *             Plan mode, in the same chat;
 *   reject  — the plan is dropped; an optional reason goes back to the model.
 *
 * Shared by the main process (validation, prompt building) and the renderer
 * (detecting a plan in a message), so it has no Electron or Node imports.
 */

import type { ChatMode } from "@/lib/schemas";

/**
 * Modes that must never modify the app: no file writes, no auto-fix, no
 * auto-complete. Plan mode used to be missing here, so a model that ignored
 * the "never write code" instruction still had its edits applied.
 */
export function isReadOnlyChatMode(mode: ChatMode | string | null | undefined): boolean {
  return mode === "ask" || mode === "plan";
}

export const PLAN_PROPOSAL_TAG = "joy-plan-proposal";

const PLAN_PROPOSAL_RE = /<joy-plan-proposal\b([^>]*)>([\s\S]*?)<\/joy-plan-proposal>/i;

export interface PlanProposal {
  title: string;
  body: string;
}

/** The first complete plan proposal in a message, or null. */
export function extractPlanProposal(content: string | null | undefined): PlanProposal | null {
  if (!content) return null;
  const match = PLAN_PROPOSAL_RE.exec(content);
  if (!match) return null;
  const title = /\btitle="([^"]*)"/i.exec(match[1])?.[1]?.trim() || "Plan";
  const body = match[2].trim();
  if (!body) return null;
  return { title, body };
}

export type PlanAction = "approve" | "reject" | "revise";

export interface PlanRespondResult {
  /** The follow-up message to send, or null when nothing should be sent. */
  prompt: string | null;
  /** Mode for that single follow-up turn; null keeps the chat's own mode. */
  chatModeOverride: ChatMode | null;
}

/**
 * The follow-up turn for a plan decision.
 *
 * Throws on a revise with no feedback: an empty "revise" would just regenerate
 * the same plan and look like the button did nothing.
 */
export function buildPlanRespondPrompt(params: {
  action: PlanAction;
  planTitle: string;
  feedback?: string;
}): PlanRespondResult {
  const feedback = params.feedback?.trim();

  switch (params.action) {
    case "approve":
      return {
        prompt:
          `I approve the plan "${params.planTitle}" above. Implement it now, following its steps in order. ` +
          `Stay within the plan's scope; if something in it turns out to be wrong, say so instead of improvising.`,
        chatModeOverride: "build",
      };
    case "revise":
      if (!feedback) {
        throw new Error("Revising a plan needs feedback describing what to change.");
      }
      return {
        prompt:
          `Revise the plan "${params.planTitle}" based on this feedback, and output the complete updated plan:\n\n${feedback}`,
        chatModeOverride: null,
      };
    case "reject":
      return {
        prompt: feedback
          ? `I'm rejecting the plan "${params.planTitle}" — do not implement it. Reason: ${feedback}`
          : `I'm rejecting the plan "${params.planTitle}" — do not implement it. Wait for my next request.`,
        chatModeOverride: null,
      };
    default: {
      const exhaustive: never = params.action;
      throw new Error(`Unknown plan action: ${String(exhaustive)}`);
    }
  }
}
