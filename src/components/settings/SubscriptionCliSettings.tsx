/**
 * "Use the plan you already pay for."
 *
 * Every other provider in Settings asks for an API key — a metered credential
 * billed per token. Most people do not buy AI that way; they pay a flat monthly
 * fee for Claude Pro/Max, ChatGPT Plus/Pro, Google AI Pro or GitHub Copilot.
 * This panel lets those plans drive JoyCreate, the same way they drive Claude
 * Code and the VS Code extensions: through the vendor's own signed-in CLI.
 *
 * The design rule here is that the panel never claims more than it knows.
 * "Installed" and "signed in" are checks against the filesystem; only the Test
 * button, which sends a real prompt, can say the plan actually works — so that
 * is the only thing allowed to render as a success.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";

import { IpcClient } from "@/ipc/ipc_client";
import type { SubscriptionCliDetection } from "@/ipc/ipc_types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; reply: string; durationMs: number }
  | { kind: "failed"; message: string };

export function SubscriptionCliSettings() {
  const [clis, setClis] = useState<SubscriptionCliDetection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const load = useCallback(async (force: boolean) => {
    setRefreshing(force);
    try {
      const found = force
        ? await IpcClient.getInstance().refreshSubscriptionClis()
        : await IpcClient.getInstance().detectSubscriptionClis();
      setClis(found);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const runTest = async (cli: SubscriptionCliDetection) => {
    setTests((t) => ({ ...t, [cli.id]: { kind: "running" } }));
    try {
      const result = await IpcClient.getInstance().testSubscriptionCli(
        cli.id,
        cli.models[0]?.id,
      );
      setTests((t) => ({
        ...t,
        [cli.id]: {
          kind: "ok",
          reply: result.reply,
          durationMs: result.durationMs,
        },
      }));
    } catch (err) {
      setTests((t) => ({
        ...t,
        [cli.id]: {
          kind: "failed",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm p-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h2 className="text-lg font-medium text-gray-900 dark:text-white">
          Use your AI subscription
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(true)}
          disabled={refreshing}
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          <span className="ml-2">Re-scan</span>
        </Button>
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5 max-w-3xl">
        If you already pay for Claude Pro/Max, ChatGPT Plus/Pro, Google AI Pro or
        GitHub Copilot, you do not need an API key as well. JoyCreate can run
        prompts through the vendor's own command-line agent — the same thing
        Claude Code and the VS Code extensions use — so requests count against
        the plan you have instead of metered credit. Install the CLI, sign in
        once, and its models appear in the model picker.
      </p>

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Could not scan for CLIs: {loadError}
        </div>
      )}

      {clis === null && !loadError && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Looking for installed CLIs…
        </div>
      )}

      <div className="space-y-3">
        {clis?.map((cli) => (
          <CliCard
            key={cli.id}
            cli={cli}
            test={tests[cli.id] ?? { kind: "idle" }}
            onTest={() => void runTest(cli)}
          />
        ))}
      </div>

      <p className="mt-5 text-xs text-gray-500 dark:text-gray-400 max-w-3xl">
        JoyCreate never reads the credential files these tools create — the CLI
        holds and refreshes its own token, exactly as it does for your editor.
        API keys in your environment are hidden from the CLI when it runs, so a
        subscription request can never quietly fall through to paid billing.
      </p>
    </div>
  );
}

function CliCard({
  cli,
  test,
  onTest,
}: {
  cli: SubscriptionCliDetection;
  test: TestState;
  onTest: () => void;
}) {
  const ready = cli.installed && cli.signedIn;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <span className="font-medium text-gray-900 dark:text-white">
          {cli.label}
        </span>
        <span className="text-xs text-gray-500">{cli.vendor}</span>
        {ready ? (
          <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200">
            Ready
          </Badge>
        ) : cli.installed ? (
          <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            Not signed in
          </Badge>
        ) : (
          <Badge variant="outline">Not installed</Badge>
        )}
        {cli.version && (
          <span className="text-xs text-gray-400 font-mono">{cli.version}</span>
        )}
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-300">
        Covered by: {cli.subscription}
      </p>

      {!ready && (
        <div className="mt-3 space-y-2">
          {!cli.installed && (
            <CommandLine label="Install" command={cli.installCommand} />
          )}
          <CommandLine label="Sign in" command={cli.loginCommand} />
          <p className="text-xs text-gray-500">
            Run these in a terminal, then press Re-scan.
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onTest}
          disabled={!cli.installed || test.kind === "running"}
          title={
            cli.installed
              ? "Sends one real prompt through the CLI"
              : "Install the CLI first"
          }
        >
          {test.kind === "running" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Terminal className="h-4 w-4" />
          )}
          <span className="ml-2">
            {test.kind === "running" ? "Testing…" : "Test"}
          </span>
        </Button>

        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void IpcClient.getInstance().openSubscriptionCliDocs(cli.id)
          }
        >
          <ExternalLink className="h-4 w-4" />
          <span className="ml-2">Docs</span>
        </Button>

        {cli.binaryPath && (
          <span
            className="text-xs text-gray-400 font-mono truncate max-w-[22rem]"
            title={cli.binaryPath}
          >
            {cli.binaryPath}
          </span>
        )}
      </div>

      {test.kind === "ok" && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-emerald-50 dark:bg-emerald-950 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            Working — replied “{test.reply}” in{" "}
            {(test.durationMs / 1000).toFixed(1)}s. Its models are in the model
            picker now.
          </span>
        </div>
      )}

      {test.kind === "failed" && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-900 dark:text-red-100">
          <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
          {/* The CLI's own wording, not ours — it is the thing that knows
              whether the session expired or the plan is out of quota. */}
          <span className="whitespace-pre-wrap break-words">{test.message}</span>
        </div>
      )}
    </div>
  );
}

function CommandLine({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs w-14 shrink-0 text-gray-500">{label}</span>
      <code className="flex-1 truncate rounded bg-gray-100 dark:bg-gray-900 px-2 py-1 text-xs font-mono text-gray-800 dark:text-gray-200">
        {command}
      </code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <Copy className="h-3.5 w-3.5" />
        <span className="ml-1 text-xs">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}
