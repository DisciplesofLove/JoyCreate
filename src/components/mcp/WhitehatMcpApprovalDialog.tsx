/**
 * WhitehatMcpApprovalDialog — modal that appears whenever the Whitehat MCP
 * sandbox proxy intercepts a `tools/call` from Claude Desktop and needs the
 * user to allow/deny it.
 *
 * Mounted once at the app root. Listens via `useWhitehatMcpPending`; renders
 * the oldest pending entry first, queueing the rest until they resolve.
 */

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useWhitehatMcpPending } from "@/hooks/useWhitehatMcp";

export function WhitehatMcpApprovalDialog() {
  const { pending, respond } = useWhitehatMcpPending();
  const current = pending[0];

  const argsPretty = useMemo(() => {
    if (!current) return "";
    try {
      return JSON.stringify(current.args, null, 2);
    } catch {
      return String(current.args);
    }
  }, [current]);

  if (!current) return null;

  const decide = (choice: "once" | "always" | "deny") => {
    respond.mutate({ id: current.id, choice });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && decide("deny")}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Whitehat — MCP tool approval</DialogTitle>
          <DialogDescription>
            Claude Desktop is asking to invoke an MCP tool. Approve only if you
            recognize the action.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>
            <span className="font-medium">Server:</span>{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              {current.serverName}
            </code>
          </div>
          <div>
            <span className="font-medium">Tool:</span>{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              {current.toolName}
            </code>
          </div>
          <div>
            <span className="font-medium">Hash:</span>{" "}
            <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded break-all">
              {current.invocationHash}
            </code>
          </div>
          <div>
            <span className="font-medium block mb-1">Arguments:</span>
            <pre className="text-xs bg-muted p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap break-all">
              {argsPretty}
            </pre>
          </div>
          {pending.length > 1 ? (
            <p className="text-xs text-muted-foreground">
              {pending.length - 1} more request
              {pending.length - 1 === 1 ? "" : "s"} queued.
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="destructive"
            onClick={() => decide("deny")}
            disabled={respond.isPending}
          >
            Deny
          </Button>
          <Button
            variant="outline"
            onClick={() => decide("once")}
            disabled={respond.isPending}
          >
            Allow once
          </Button>
          <Button
            onClick={() => decide("always")}
            disabled={respond.isPending}
          >
            Allow always
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
