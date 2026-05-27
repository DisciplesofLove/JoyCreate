import type {
  ChatPlanDraft,
  ChatPlanPhase,
} from "@/shared/chat_plan_types";

/**
 * Matches `<joy-plan>{...json...}</joy-plan>` blocks. The model is instructed
 * (in `AUTONOMOUS_MODE_SYSTEM_PROMPT`) to emit exactly one such block on the
 * first turn.
 */
const PLAN_TAG_RE = /<joy-plan>([\s\S]*?)<\/joy-plan>/i;

export interface ParsedPlan {
  draft: ChatPlanDraft;
  /** Phases pre-normalized with `status: "pending"` and stable IDs. */
  phases: ChatPlanPhase[];
}

function slugify(input: string, fallback: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/**
 * Extract and normalize a `<joy-plan>` block from raw assistant text.
 * Returns `null` if no block is present or the JSON is invalid.
 */
export function parseChatPlanFromText(text: string): ParsedPlan | null {
  if (!text) return null;
  const match = text.match(PLAN_TAG_RE);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
  const phasesRaw = Array.isArray(obj.phases) ? obj.phases : [];
  if (!goal || phasesRaw.length === 0) return null;

  const draftPhases: ChatPlanDraft["phases"] = [];
  const phases: ChatPlanPhase[] = [];
  const usedIds = new Set<string>();

  for (let i = 0; i < phasesRaw.length; i++) {
    const raw = phasesRaw[i];
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const title =
      typeof p.title === "string" && p.title.trim() ? p.title.trim() : null;
    if (!title) continue;

    const description =
      typeof p.description === "string" ? p.description.trim() : undefined;
    const steps = Array.isArray(p.steps)
      ? (p.steps.filter((s) => typeof s === "string") as string[])
      : undefined;

    let id =
      typeof p.id === "string" && p.id.trim()
        ? slugify(p.id, `phase-${i + 1}`)
        : slugify(title, `phase-${i + 1}`);
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${id}-${suffix++}`;
    }
    usedIds.add(id);

    draftPhases.push({ id, title, description, steps });
    phases.push({
      id,
      title,
      description,
      steps,
      status: "pending",
    });
  }

  if (phases.length === 0) return null;

  return {
    draft: { goal, phases: draftPhases },
    phases,
  };
}

/**
 * Strip the `<joy-plan>` block from text so it isn't displayed twice in the
 * chat transcript.
 */
export function stripChatPlanTag(text: string): string {
  return text.replace(PLAN_TAG_RE, "").trim();
}

/**
 * Matches `<joy-phase-complete id="..." status="done|failed|skipped"
 * summary="..." error="..." />`. The autonomous-mode prompt instructs the
 * model to emit exactly one such self-closing tag at the end of each
 * phase-execution turn so the runtime can update progress without a human
 * in the loop.
 */
const PHASE_COMPLETE_TAG_RE =
  /<joy-phase-complete\b([^>]*?)\/?>(?:\s*<\/joy-phase-complete>)?/i;

const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

export interface ParsedPhaseComplete {
  phaseId: string;
  status: "done" | "failed" | "skipped";
  summary?: string;
  error?: string;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/**
 * Extract the `<joy-phase-complete>` tag from raw assistant text. Returns
 * `null` if no tag is present or required attributes are missing.
 */
export function parsePhaseCompleteFromText(
  text: string,
): ParsedPhaseComplete | null {
  if (!text) return null;
  const match = text.match(PHASE_COMPLETE_TAG_RE);
  if (!match) return null;
  const attrs = parseAttrs(match[1] ?? "");
  const phaseId = (attrs.id ?? "").trim();
  if (!phaseId) return null;
  const statusRaw = (attrs.status ?? "done").toLowerCase();
  const status: ParsedPhaseComplete["status"] =
    statusRaw === "failed" || statusRaw === "skipped" ? statusRaw : "done";
  return {
    phaseId,
    status,
    summary: attrs.summary?.trim() || undefined,
    error: attrs.error?.trim() || undefined,
  };
}

/** Remove the phase-complete tag from saved message text. */
export function stripPhaseCompleteTag(text: string): string {
  return text.replace(PHASE_COMPLETE_TAG_RE, "").trim();
}
