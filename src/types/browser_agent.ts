/**
 * Browser Agent types — an autonomous web agent that drives the Smart
 * Browser's active webview through a ReAct-style plan/act/observe loop.
 *
 * The renderer-side runner ([browser_agent_runner.ts]) executes actions
 * against the webview. The main-process IPC handler
 * ("browser-agent:plan-step") asks the user's local LLM what to do next.
 */

export type BrowserAgentActionType =
  | "navigate"
  | "click"
  | "fill"
  | "press_key"
  | "scroll"
  | "extract"
  | "wait"
  | "back"
  | "forward"
  | "reload"
  | "open_tab"
  | "tool_call"
  | "done";

export interface BrowserAgentAction {
  thought?: string;
  action: BrowserAgentActionType;
  params?: Record<string, unknown>;
  /** Set by the model when the task is complete. */
  done?: boolean;
  /** Final natural-language answer when action="done". */
  answer?: string;
}

export interface BrowserAgentInteractive {
  /** Stable index assigned by the tagging script (data-joy-aid). */
  i: number;
  /** Tag name lowercased. */
  t: string;
  /** ARIA role / type. */
  r?: string;
  /** Visible text / placeholder / aria-label, truncated. */
  text?: string;
  /** Input value snapshot. */
  value?: string;
  /** href for anchors. */
  href?: string;
  /** True if element is currently in the viewport. */
  inView?: boolean;
}

export interface BrowserAgentObservation {
  step: number;
  url: string;
  title: string;
  /** Truncated body text for grounding. */
  text: string;
  /** Top interactive elements, sorted by viewport-first then DOM order. */
  elements: BrowserAgentInteractive[];
  /** Outcome of the action that produced this observation. */
  result: string;
}

export interface BrowserAgentTurn {
  step: number;
  action: BrowserAgentAction;
  observation: BrowserAgentObservation | null;
}

export interface BrowserAgentPlanRequest {
  /** User's original task. */
  task: string;
  /** Conversation/turn history so far. */
  history: BrowserAgentTurn[];
  /** Latest observation to plan against. */
  observation: BrowserAgentObservation;
  /** Names of allowed `tool_call` tools. */
  allowedTools: string[];
  /** Optional model override (defaults to user's selected model). */
  model?: string;
}

export interface BrowserAgentRunState {
  status: "idle" | "running" | "stopping" | "stopped" | "done" | "error";
  step: number;
  task: string;
  history: BrowserAgentTurn[];
  finalAnswer?: string;
  errorMessage?: string;
}
