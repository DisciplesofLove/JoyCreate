import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Top-level error boundary for the renderer.
 *
 * Wraps the TanStack Router `<Outlet />` so an exception inside any route
 * tree renders a friendly recovery UI instead of a blank white screen.
 * Logs the error to the console so the main-process log forwarder
 * (`forward-renderer-logs`) captures it.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[RouteErrorBoundary] caught render error", error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReset = (): void => {
    this.setState({ error: null, errorInfo: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full min-h-[60vh] w-full items-center justify-center p-6">
        <div className="max-w-xl w-full rounded-xl border border-red-500/30 bg-red-500/5 p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-red-500/10 flex items-center justify-center text-red-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Something went wrong</h2>
              <p className="text-sm text-muted-foreground">
                A page in JoyCreate failed to render. You can try again or
                reload the app.
              </p>
            </div>
          </div>
          <div className="rounded-md bg-background/40 border border-border/50 p-3">
            <p className="text-xs font-mono text-red-300 break-all">
              {error.name}: {error.message}
            </p>
            {errorInfo?.componentStack ? (
              <pre className="mt-2 text-[10px] font-mono text-muted-foreground max-h-40 overflow-auto whitespace-pre-wrap">
                {errorInfo.componentStack}
              </pre>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={this.handleReset}>
              <RotateCcw className="h-4 w-4 mr-1" />
              Try again
            </Button>
            <Button size="sm" onClick={this.handleReload}>
              Reload app
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
