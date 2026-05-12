/**
 * Copilot orchestrator — single entry point for the NLP-driven assistant.
 *
 * Flow:
 *   ask(prompt)
 *     → create copilot_jobs row (pending)
 *     → classifyPrompt() via local Ollama router
 *     → kind="chat"  → store reply, mark completed
 *     → kind="tool"  → invoke allowlisted IPC tool, store result, mark completed
 *     → kind="code-task" → run Claude Code SDK on a branch,
 *                          store branch + diff + summary, mark awaiting-approval
 *     → emit provenance event for every state transition (mirrored to hyper)
 *
 * approve(jobId) / reject(jobId) close out awaiting-approval rows.
 */

import { v4 as uuidv4 } from "uuid";
import log from "electron-log";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { copilotJobs, type CopilotJobRow } from "@/db/copilot_schema";
import { classifyPrompt, type RouterOptions } from "./local_router";
import {
  findCopilotTool,
  invokeCopilotTool,
} from "./tool_registry";
import { runClaudeCodeJob } from "./claude_runner";
import type { CopilotIntent } from "./intent_schema";

const logger = log.scope("copilot:service");

export interface CopilotAskInput {
  prompt: string;
  /** Override the local router model. */
  routerOptions?: RouterOptions;
  /** Override Claude API key (else falls back to env). */
  claudeApiKey?: string;
  /** Optional UI callback for streaming progress. */
  onProgress?: (chunk: { stage: string; content: string }) => void;
}

export interface CopilotAskResult {
  jobId: string;
  job: CopilotJobRow;
}

class CopilotService {
  /**
   * Run a fresh user prompt end-to-end. Returns the resulting job row.
   * For code-tasks, the row will be in "awaiting-approval" state with a
   * branchName + diffPath set.
   */
  async ask(input: CopilotAskInput): Promise<CopilotAskResult> {
    const jobId = uuidv4();
    const now = new Date();

    const initial = db
      .insert(copilotJobs)
      .values({
        id: jobId,
        userPrompt: input.prompt,
        kind: "chat", // tentative — updated after classification
        status: "running",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    let intent: CopilotIntent;
    try {
      input.onProgress?.({ stage: "routing", content: "Classifying request..." });
      intent = await classifyPrompt(input.prompt, input.routerOptions);
    } catch (err) {
      return this.failJob(jobId, `Router error: ${(err as Error).message}`);
    }

    db.update(copilotJobs)
      .set({
        intentJson: intent as unknown as Record<string, unknown>,
        kind: intent.kind,
        toolName: intent.tool,
        summary: intent.summary,
        updatedAt: new Date(),
      })
      .where(eq(copilotJobs.id, jobId))
      .run();

    if (intent.kind === "chat") {
      return this.completeChat(jobId, intent);
    }

    if (intent.kind === "tool") {
      return this.runTool(jobId, intent, input);
    }

    return this.runCodeTask(jobId, intent, input);
  }

  /** Approve an awaiting-approval job (e.g. accept Claude's diff). */
  async approve(jobId: string, approverDid: string): Promise<CopilotJobRow> {
    const row = db
      .update(copilotJobs)
      .set({
        status: "completed",
        approvedBy: approverDid,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(copilotJobs.id, jobId))
      .returning()
      .get();
    if (!row) throw new Error(`Copilot job not found: ${jobId}`);
    this.emitProvenance(row, "completed");
    return row;
  }

  async reject(jobId: string, approverDid: string, reason?: string): Promise<CopilotJobRow> {
    const row = db
      .update(copilotJobs)
      .set({
        status: "rejected",
        approvedBy: approverDid,
        errorMessage: reason ?? null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(copilotJobs.id, jobId))
      .returning()
      .get();
    if (!row) throw new Error(`Copilot job not found: ${jobId}`);
    this.emitProvenance(row, "rejected");
    return row;
  }

  async cancel(jobId: string): Promise<CopilotJobRow> {
    const row = db
      .update(copilotJobs)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(copilotJobs.id, jobId))
      .returning()
      .get();
    if (!row) throw new Error(`Copilot job not found: ${jobId}`);
    return row;
  }

  list(limit = 50): CopilotJobRow[] {
    return db
      .select()
      .from(copilotJobs)
      .orderBy(desc(copilotJobs.createdAt))
      .limit(limit)
      .all();
  }

  get(jobId: string): CopilotJobRow | undefined {
    return db
      .select()
      .from(copilotJobs)
      .where(eq(copilotJobs.id, jobId))
      .get();
  }

  // ---- internal -----------------------------------------------------------

  private completeChat(jobId: string, intent: CopilotIntent): CopilotAskResult {
    const reply = intent.reply ?? "(no reply)";
    const row = db
      .update(copilotJobs)
      .set({
        status: "completed",
        output: reply,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(copilotJobs.id, jobId))
      .returning()
      .get();
    this.emitProvenance(row, "chat");
    return { jobId, job: row };
  }

  private async runTool(
    jobId: string,
    intent: CopilotIntent,
    input: CopilotAskInput,
  ): Promise<CopilotAskResult> {
    if (!intent.tool) {
      return this.failJob(jobId, "Tool intent missing tool name");
    }
    const tool = findCopilotTool(intent.tool);
    if (!tool) {
      return this.failJob(jobId, `Tool "${intent.tool}" is not in the allowlist`);
    }

    input.onProgress?.({ stage: "tool", content: `Running ${tool.name}...` });
    let toolResult: unknown;
    try {
      toolResult = await invokeCopilotTool(tool, intent.args ?? {});
    } catch (err) {
      return this.failJob(jobId, `Tool "${tool.name}" failed: ${(err as Error).message}`);
    }

    const summary =
      typeof toolResult === "string"
        ? toolResult
        : `Tool ${tool.name} returned ${summarizeResult(toolResult)}`;

    const row = db
      .update(copilotJobs)
      .set({
        status: "completed",
        output: JSON.stringify(toolResult, null, 2),
        summary,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(copilotJobs.id, jobId))
      .returning()
      .get();
    this.emitProvenance(row, "tool");
    return { jobId, job: row };
  }

  private async runCodeTask(
    jobId: string,
    intent: CopilotIntent,
    input: CopilotAskInput,
  ): Promise<CopilotAskResult> {
    if (!intent.taskBrief) {
      return this.failJob(jobId, "Code-task intent missing taskBrief");
    }

    input.onProgress?.({
      stage: "claude",
      content: "Dispatching to Claude Code...",
    });

    const result = await runClaudeCodeJob({
      jobId,
      taskBrief: intent.taskBrief,
      apiKey: input.claudeApiKey,
      onProgress: (chunk) => {
        input.onProgress?.({
          stage: chunk.type === "tool" ? "claude-tool" : "claude",
          content: chunk.content,
        });
      },
    });

    if (!result.ok) {
      return this.failJob(jobId, result.errorMessage ?? "Claude run failed");
    }

    const row = db
      .update(copilotJobs)
      .set({
        status: result.diffPath ? "awaiting-approval" : "completed",
        output: result.output,
        summary: intent.summary ?? `Claude proposed changes on ${result.branchName}`,
        branchName: result.branchName,
        diffPath: result.diffPath,
        claudeCostUsd: String(result.costUsd),
        completedAt: result.diffPath ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(copilotJobs.id, jobId))
      .returning()
      .get();
    this.emitProvenance(row, "code-task");
    return { jobId, job: row };
  }

  private failJob(jobId: string, message: string): CopilotAskResult {
    logger.warn(`Copilot job ${jobId} failed: ${message}`);
    const row = db
      .update(copilotJobs)
      .set({
        status: "failed",
        errorMessage: message,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(copilotJobs.id, jobId))
      .returning()
      .get();
    this.emitProvenance(row, "failed");
    return { jobId, job: row };
  }

  private emitProvenance(row: CopilotJobRow | undefined, stage: string): void {
    if (!row) return;
    // Fire-and-forget — provenance is best-effort, never blocks the user.
    void (async () => {
      try {
        const { emitEvent } = await import("@/lib/agent_provenance");
        await emitEvent({
          principalDid: "did:joy:copilot",
          kind: "external",
          subjectRef: row.id,
          payload: {
            stage,
            jobKind: row.kind,
            status: row.status,
            tool: row.toolName,
            branch: row.branchName,
            costUsd: row.claudeCostUsd,
            summary: row.summary,
          },
        });
      } catch (err) {
        logger.debug("provenance emit skipped:", err);
      }
    })();
  }
}

function summarizeResult(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (value && typeof value === "object") {
    return `${Object.keys(value).length} field(s)`;
  }
  return String(value);
}

let _instance: CopilotService | null = null;
export function getCopilotService(): CopilotService {
  if (!_instance) _instance = new CopilotService();
  return _instance;
}
