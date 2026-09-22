/**
 * update_todos tool — Maintain a live, visible task checklist for the current
 * mission. The agent calls this to lay out its plan and then to tick items off
 * as it completes them, giving the user real-time visibility into progress on
 * multi-step work.
 *
 * The tool is purely presentational (it does not touch the codebase). It emits
 * a <joy-todos> block that the chat UI renders as a checklist. The returned
 * text echoes the current list back to the model so it stays anchored to the
 * plan.
 */

import { z } from "zod";
import { ToolDefinition, escapeXmlContent } from "./types";

const todoItemSchema = z.object({
  title: z.string().describe("Short, action-oriented description of the task"),
  status: z
    .enum(["pending", "in_progress", "done"])
    .describe(
      "Task state: 'pending' (not started), 'in_progress' (working now — keep at most one), or 'done' (completed).",
    ),
});

const updateTodosSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .min(1)
    .describe(
      "The full, current task list. Always pass the COMPLETE list (not a delta) so the UI reflects the true state.",
    ),
});

type UpdateTodosInput = z.infer<typeof updateTodosSchema>;

const STATUS_MARK: Record<string, string> = {
  done: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

export const updateTodosTool: ToolDefinition<UpdateTodosInput> = {
  name: "update_todos",
  description: `Maintain a live task checklist for multi-step work so the user can see your plan and progress.
Use this to:
- Lay out the steps of a non-trivial task BEFORE starting (all "pending").
- Mark exactly ONE item "in_progress" as you work on it.
- Mark items "done" immediately after finishing them, then move to the next.
Always pass the COMPLETE current list each time (not just changes). Skip this for trivial single-step tasks.
This tool does NOT modify code — it only tracks progress.`,
  inputSchema: updateTodosSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => {
    const total = args.todos?.length ?? 0;
    const done = args.todos?.filter((t) => t.status === "done").length ?? 0;
    return `Update todos (${done}/${total} done)`;
  },

  buildXml: (args, isComplete) => {
    const todos = args.todos ?? [];
    let xml = "<joy-todos>\n";
    for (const t of todos) {
      if (!t?.title) continue;
      const mark = STATUS_MARK[t.status] ?? "[ ]";
      xml += `${mark} ${escapeXmlContent(t.title)}\n`;
    }
    if (isComplete) {
      xml += "</joy-todos>";
    }
    return xml;
  },

  execute: async (args) => {
    const todos = args.todos ?? [];
    const total = todos.length;
    const done = todos.filter((t) => t.status === "done").length;
    const inProgress = todos.filter((t) => t.status === "in_progress").length;

    const lines = todos.map((t) => {
      const mark = STATUS_MARK[t.status] ?? "[ ]";
      return `${mark} ${t.title}`;
    });

    let summary = `Task list updated (${done}/${total} done`;
    if (inProgress > 0) summary += `, ${inProgress} in progress`;
    summary += `):\n${lines.join("\n")}`;

    if (inProgress > 1) {
      summary +=
        "\n\nNote: keep at most one task 'in_progress' at a time for clarity.";
    }

    return summary;
  },
};
