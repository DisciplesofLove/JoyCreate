import type React from "react";
import { CheckCircle2, Circle, Loader, ListTodo } from "lucide-react";
import { CustomTagState } from "./stateTypes";

interface JoyTodosProps {
  node?: any;
  children?: React.ReactNode;
}

type ParsedTodo = {
  title: string;
  status: "pending" | "in_progress" | "done";
};

/** Parse the checklist lines emitted by the update_todos tool. */
function parseTodos(raw: string): ParsedTodo[] {
  const todos: ParsedTodo[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^\[( |x|~)\]\s*(.+)$/i);
    if (!match) continue;
    const marker = match[1].toLowerCase();
    const title = match[2].trim();
    if (!title) continue;
    const status: ParsedTodo["status"] =
      marker === "x" ? "done" : marker === "~" ? "in_progress" : "pending";
    todos.push({ title, status });
  }
  return todos;
}

export const JoyTodos: React.FC<JoyTodosProps> = ({ children, node }) => {
  const state = node?.properties?.state as CustomTagState;
  const inProgress = state === "pending";
  const raw = typeof children === "string" ? children : "";
  const todos = parseTodos(raw);

  const doneCount = todos.filter((t) => t.status === "done").length;
  const total = todos.length;

  return (
    <div className="bg-(--background-lightest) rounded-lg px-4 py-2 border my-2">
      <div className="flex items-center gap-2 mb-2">
        <ListTodo size={16} className="text-indigo-600" />
        <div className="text-xs text-indigo-600 font-medium">Tasks</div>
        {total > 0 && (
          <div className="text-xs text-gray-500">
            {doneCount}/{total}
          </div>
        )}
        {inProgress && (
          <Loader size={12} className="animate-spin text-indigo-500" />
        )}
      </div>
      <ul className="space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            {t.status === "done" ? (
              <CheckCircle2
                size={16}
                className="text-green-600 mt-0.5 shrink-0"
              />
            ) : t.status === "in_progress" ? (
              <Loader
                size={16}
                className="text-indigo-500 mt-0.5 shrink-0 animate-spin"
              />
            ) : (
              <Circle size={16} className="text-gray-400 mt-0.5 shrink-0" />
            )}
            <span
              className={
                t.status === "done"
                  ? "line-through text-gray-500"
                  : t.status === "in_progress"
                    ? "text-indigo-700 dark:text-indigo-300 font-medium"
                    : "text-gray-700 dark:text-gray-300"
              }
            >
              {t.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};
