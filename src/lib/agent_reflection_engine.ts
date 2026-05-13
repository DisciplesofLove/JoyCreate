/**
 * Agent Reflection Engine
 *
 * Implements the "Reflect" half of the Plan-Execute-Reflect loop. After an
 * agent produces output for a task, the reflection engine evaluates the
 * output against the task's objective and returns a structured verdict:
 *
 *   - `accept`   → output is sufficient; move on
 *   - `retry`    → output is salvageable but flawed; rerun with critique
 *                  appended to the prompt (bounded by `maxRetries`)
 *   - `replan`   → the original plan was wrong; the orchestrator should
 *                  re-decompose the parent objective
 *
 * The engine is intentionally model-agnostic — it routes through the same
 * OpenClaw CNS the executor uses, preferring local Ollama for cost/latency
 * but falling back to cloud for hard cases.
 */

import log from "electron-log";

import { getOpenClawCNS } from "@/lib/openclaw_cns";

const logger = log.scope("agent_reflection_engine");

// =============================================================================
// TYPES
// =============================================================================

export type ReflectionVerdict = "accept" | "retry" | "replan";

export interface ReflectionInput {
  /** The high-level objective the parent orchestration is pursuing. */
  objective: string;
  /** The specific task name being evaluated. */
  taskName: string;
  /** The task description that was given to the executor. */
  taskDescription: string;
  /** The raw output produced by the executor. */
  output: string;
  /** Number of times this task has already been retried. */
  retryCount: number;
  /** Maximum retries allowed for this task. */
  maxRetries: number;
}

export interface ReflectionResult {
  verdict: ReflectionVerdict;
  /** 0-1 quality score. */
  score: number;
  /** Concise, actionable critique explaining the verdict. */
  critique: string;
  /** Specific issues detected (e.g. "missing citations", "task description ignored"). */
  issues: string[];
  /**
   * If `verdict === "retry"`, an augmented prompt fragment to append to the
   * executor's next attempt. Empty otherwise.
   */
  retryGuidance: string;
  /** Wall-clock duration of the reflection call. */
  durationMs: number;
}

// =============================================================================
// REFLECTION ENGINE
// =============================================================================

/**
 * Evaluate a task output against its objective. Returns a structured verdict
 * the orchestrator can act on. Never throws — on failure returns an
 * `accept` verdict with a low score so execution can proceed.
 */
export async function reflectOnTaskOutput(
  input: ReflectionInput,
): Promise<ReflectionResult> {
  const startedAt = Date.now();

  // Trivial early-exit: empty output is always a retry candidate.
  const trimmed = (input.output ?? "").trim();
  if (!trimmed) {
    return {
      verdict: input.retryCount < input.maxRetries ? "retry" : "accept",
      score: 0,
      critique: "Output was empty.",
      issues: ["empty_output"],
      retryGuidance:
        "Your previous attempt produced no output. Re-read the task description and produce a substantive, actionable response.",
      durationMs: Date.now() - startedAt,
    };
  }

  const reflectionPrompt = buildReflectionPrompt(input);

  try {
    const cns = getOpenClawCNS();
    // Reflection is a small JSON classification — local models handle it
    // well and we want to avoid doubling cloud spend on every task.
    const response = await cns.chat(reflectionPrompt, { preferLocal: true });
    const raw = typeof response === "string"
      ? response
      : (response as { content?: string }).content || "";

    const parsed = parseReflectionResponse(raw, input);
    return {
      ...parsed,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    logger.warn("Reflection call failed; defaulting to accept", err);
    return {
      verdict: "accept",
      score: 0.5,
      critique: "Reflection failed — accepting output to avoid blocking.",
      issues: ["reflection_error"],
      retryGuidance: "",
      durationMs: Date.now() - startedAt,
    };
  }
}

// =============================================================================
// PROMPT + PARSING
// =============================================================================

function buildReflectionPrompt(input: ReflectionInput): string {
  const remainingRetries = Math.max(0, input.maxRetries - input.retryCount);
  return `You are a strict but fair AI critic. Evaluate the output below against the task description and overall objective.

OVERALL OBJECTIVE:
${input.objective}

TASK NAME: ${input.taskName}
TASK DESCRIPTION:
${input.taskDescription}

AGENT OUTPUT (truncated to 4000 chars):
${input.output.slice(0, 4000)}

Respond with a single JSON object — no prose before or after — with this exact shape:
{
  "verdict": "accept" | "retry" | "replan",
  "score": <number 0..1>,
  "critique": "<one-sentence summary of the output's quality>",
  "issues": ["<issue tag 1>", "<issue tag 2>"],
  "retryGuidance": "<if verdict is retry, concrete instructions for the next attempt; else empty string>"
}

Verdict rules:
- "accept" — output substantively addresses the task. Minor polish issues are OK.
- "retry" — output is on-topic but flawed (incomplete, hallucinated, ignored a constraint). Only choose this if remaining retries > 0 (current remaining: ${remainingRetries}).
- "replan" — output reveals the task itself is misframed, infeasible, or depends on missing prior work. Choose only when retrying would not help.

Be concise. Output only the JSON object.`;
}

/**
 * Parse the model's JSON response. Tolerates code fences and surrounding
 * prose. Falls back to `accept` if parsing fails.
 */
function parseReflectionResponse(
  raw: string,
  input: ReflectionInput,
): Omit<ReflectionResult, "durationMs"> {
  // Strip ```json fences if present, then locate the first JSON object.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objMatch) {
    return {
      verdict: "accept",
      score: 0.5,
      critique: "Reflection response was not valid JSON.",
      issues: ["unparseable_reflection"],
      retryGuidance: "",
    };
  }

  try {
    const parsed = JSON.parse(objMatch[0]) as Partial<ReflectionResult>;
    let verdict: ReflectionVerdict =
      parsed.verdict === "retry" || parsed.verdict === "replan"
        ? parsed.verdict
        : "accept";

    // Bound: do not let the model demand more retries than allowed.
    if (verdict === "retry" && input.retryCount >= input.maxRetries) {
      verdict = "accept";
    }

    return {
      verdict,
      score: clampScore(parsed.score),
      critique: typeof parsed.critique === "string" ? parsed.critique.slice(0, 500) : "",
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.filter((i): i is string => typeof i === "string").slice(0, 10)
        : [],
      retryGuidance:
        verdict === "retry" && typeof parsed.retryGuidance === "string"
          ? parsed.retryGuidance.slice(0, 1000)
          : "",
    };
  } catch (err) {
    logger.debug("Reflection JSON parse failed", err);
    return {
      verdict: "accept",
      score: 0.5,
      critique: "Reflection response was not valid JSON.",
      issues: ["unparseable_reflection"],
      retryGuidance: "",
    };
  }
}

function clampScore(v: unknown): number {
  if (typeof v !== "number" || Number.isNaN(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}
