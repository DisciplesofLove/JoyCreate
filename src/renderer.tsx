import { StrictMode, useEffect, Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import { RouterProvider } from "@tanstack/react-router";
import { PostHogProvider } from "posthog-js/react";
import posthog from "posthog-js";
import { getTelemetryUserId, isTelemetryOptedIn } from "./hooks/useSettings";
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  MutationCache,
} from "@tanstack/react-query";
import { showError, showMcpConsentToast } from "./lib/toast";
import { IpcClient } from "./ipc/ipc_client";
import { useSetAtom } from "jotai";
import { pendingAgentConsentsAtom } from "./atoms/chatAtoms";
import { JoyWalletProviders } from "./config/joy-wallet-providers";

// @ts-ignore
console.log("Running in mode:", import.meta.env.MODE);

// Top-level boundary so a single provider/page failure doesn't blank the
// entire window. Logs to console (forwarded to main.log via webContents
// console-message hook) and shows a recovery UI.
class RendererErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(
      "[renderer] Unhandled render error:",
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      const message = this.state.error.message || String(this.state.error);
      const stack = this.state.error.stack || "";
      return (
        <div
          style={{
            fontFamily:
              "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            padding: 24,
            maxWidth: 900,
            margin: "40px auto",
            color: "#111",
            background: "#fff",
            border: "1px solid #e2e2e2",
            borderRadius: 12,
            boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
          }}
        >
          <h1 style={{ marginTop: 0, fontSize: 22 }}>
            JoyCreate hit a render error
          </h1>
          <p style={{ color: "#444" }}>
            The renderer crashed before the app could mount. Reload to try
            again — the underlying error is below.
          </p>
          <pre
            style={{
              background: "#fafafa",
              border: "1px solid #eee",
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
            }}
          >
            {message}
            {"\n\n"}
            {stack}
          </pre>
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                border: "1px solid #7c3aed",
                background: "#7c3aed",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Reload window
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                border: "1px solid #ddd",
                background: "#fff",
                color: "#333",
                cursor: "pointer",
              }}
            >
              Dismiss & try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface MyMeta extends Record<string, unknown> {
  showErrorToast: boolean;
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: MyMeta;
    mutationMeta: MyMeta;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.meta?.showErrorToast) {
        showError(error);
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.showErrorToast) {
        showError(error);
      }
    },
  }),
});

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY || "";
const posthogClient = POSTHOG_KEY ? posthog.init(
  POSTHOG_KEY,
  {
    api_host: "https://us.i.posthog.com",
    // @ts-ignore
    debug: import.meta.env.MODE === "development",
    autocapture: false,
    capture_exceptions: true,
    capture_pageview: false,
    before_send: (event) => {
      if (!isTelemetryOptedIn()) {
        console.debug("Telemetry not opted in, skipping event");
        return null;
      }
      const telemetryUserId = getTelemetryUserId();
      if (telemetryUserId) {
        posthogClient?.identify(telemetryUserId);
      }

      if (event?.properties["$ip"]) {
        event.properties["$ip"] = null;
      }

      console.debug(
        "Telemetry opted in - UUID:",
        telemetryUserId,
        "sending event",
        event,
      );
      return event;
    },
    persistence: "localStorage",
  },
) : undefined;

function App() {
  useEffect(() => {
    // Subscribe to navigation state changes
    const unsubscribe = router.subscribe("onResolved", (navigation) => {
      // Capture the navigation event in PostHog
      posthog.capture("navigation", {
        toPath: navigation.toLocation.pathname,
        fromPath: navigation.fromLocation?.pathname,
      });

      // Optionally capture as a standard pageview as well
      posthog.capture("$pageview", {
        path: navigation.toLocation.pathname,
      });
    });

    // Clean up subscription when component unmounts
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsubscribe = ipc.onMcpToolConsentRequest((payload) => {
      showMcpConsentToast({
        serverName: payload.serverName,
        toolName: payload.toolName,
        toolDescription: payload.toolDescription,
        inputPreview: payload.inputPreview,
        onDecision: (d) => ipc.respondToMcpConsentRequest(payload.requestId, d),
      });
    });
    return () => unsubscribe();
  }, []);

  // Agent v2 tool consent requests - queue consents instead of overwriting
  const setPendingAgentConsents = useSetAtom(pendingAgentConsentsAtom);
  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsubscribe = ipc.onAgentToolConsentRequest((payload) => {
      setPendingAgentConsents((prev) => [
        ...prev,
        {
          requestId: payload.requestId,
          chatId: payload.chatId,
          toolName: payload.toolName,
          toolDescription: payload.toolDescription,
          inputPreview: payload.inputPreview,
        },
      ]);
    });
    return () => unsubscribe();
  }, [setPendingAgentConsents]);

  // Clear pending agent consents when a chat stream ends or errors
  // This prevents stale consent banners from remaining visible after cancellation
  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsubscribe = ipc.onChatStreamEnd((chatId) => {
      setPendingAgentConsents((prev) =>
        prev.filter((consent) => consent.chatId !== chatId),
      );
    });
    return () => unsubscribe();
  }, [setPendingAgentConsents]);

  // Forward telemetry events from main process to PostHog
  useEffect(() => {
    const ipc = IpcClient.getInstance();
    const unsubscribe = ipc.onTelemetryEvent(({ eventName, properties }) => {
      posthog.capture(eventName, properties);
    });
    return () => unsubscribe();
  }, []);

  return <RouterProvider router={router} />;
}

createRoot(document.getElementById("root")!).render(
  <RendererErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <JoyWalletProviders>
        {posthogClient ? (
          <PostHogProvider client={posthogClient}>
            <App />
          </PostHogProvider>
        ) : (
          <App />
        )}
      </JoyWalletProviders>
    </QueryClientProvider>
  </RendererErrorBoundary>,
);
