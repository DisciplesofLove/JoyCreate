/**
 * JoyAssistantBoundary
 *
 * Self-healing error boundary for the floating Joy Assistant panel.
 *
 * Why this exists:
 *   When the panel itself throws during render (e.g. a malformed persisted
 *   session, a missing model client, a hook contract change), React unmounts
 *   the entire <JoyAssistantPanel /> subtree.  That includes the floating
 *   sparkles trigger button — so users see "clicking the icon does nothing"
 *   with no obvious error.  This boundary keeps a minimal recovery trigger
 *   visible and surfaces the real error to the DevTools console so we can
 *   diagnose future regressions without guessing.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Sparkles } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class JoyAssistantBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface a recognisable, greppable line so DevTools shows exactly which
    // subsystem crashed and why.  We intentionally do NOT swallow the stack.
    console.error(
      "[JoyAssistant] panel crashed during render — recovering with fallback trigger.",
      "\nerror:",
      error,
      "\ncomponentStack:",
      info.componentStack,
    );
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const message = this.state.error.message || "Unknown error";
      return (
        <button
          type="button"
          onClick={this.reset}
          title={`Joy Assistant crashed (click to retry): ${message}`}
          aria-label="Joy Assistant crashed — click to retry"
          className="fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-lg hover:scale-105 transition-transform"
        >
          <Sparkles className="h-5 w-5" />
        </button>
      );
    }
    return this.props.children;
  }
}
