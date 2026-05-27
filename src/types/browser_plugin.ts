/**
 * BrowserPlugin — user-defined or AI-generated extension that augments
 * the Smart Browser.
 *
 * Three flavours:
 *  - "page-action": shows up as a one-tap button in the AI panel quick-
 *    actions row. Its `code` runs inside the current tab's webview via
 *    `executeJavaScript` and must return either a string or an object that
 *    will be serialized and fed into the AI as context.
 *  - "widget": renders as a card in the side panel "Plugins" tab. `code`
 *    runs on-demand against the active page; its return value is shown
 *    in the widget card.
 *  - "command": invokable by name from a prompt; produces a prompt
 *    addendum that the AI uses to answer.
 */

export type BrowserPluginType = "page-action" | "widget" | "command";

export interface BrowserPlugin {
  id: string;
  name: string;
  description: string;
  type: BrowserPluginType;
  /**
   * JavaScript executed inside the active webview. Must be an expression
   * that evaluates to a JSON-serializable value (string / number / object
   * / array). Runs in the page's isolated world.
   */
  code: string;
  /**
   * For "page-action" / "command" plugins: an optional Mustache-style
   * template appended to the AI prompt after the page snapshot. Available
   * variables: {{result}}, {{url}}, {{title}}.
   *
   * If absent the raw `result` is sent as a fenced block.
   */
  promptTemplate?: string;
  /** Lucide icon name, e.g. "Sparkles". Falls back to "Wand2". */
  icon?: string;
  enabled: boolean;
  /** True for built-in samples shipped with the app. */
  builtin?: boolean;
  /** Optional author/source — for plugins the AI built, set to "ai". */
  author?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBrowserPluginRequest {
  name: string;
  description: string;
  type: BrowserPluginType;
  code: string;
  promptTemplate?: string;
  icon?: string;
  enabled?: boolean;
  author?: string;
}

export interface UpdateBrowserPluginRequest {
  id: string;
  patch: Partial<Omit<BrowserPlugin, "id" | "createdAt">>;
}

export interface BuildBrowserPluginRequest {
  /** Natural-language description of what the plugin should do. */
  description: string;
  /** Optional hint: the URL the user is currently on. */
  currentUrl?: string;
  /** Optional override; default uses the user's selected local model. */
  model?: string;
}
