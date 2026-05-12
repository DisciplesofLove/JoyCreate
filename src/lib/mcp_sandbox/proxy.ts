/**
 * Whitehat MCP stdio proxy.
 *
 * Spawned by Claude Desktop in place of a real MCP server. Forwards stdio
 * traffic to the wrapped child server but intercepts every `tools/call`
 * JSON-RPC request, gates it through `policy.evaluate`, and short-circuits
 * with a JSON-RPC error when denied.
 *
 * Design notes:
 * - Uses LSP/MCP framing (`Content-Length` headers) IF detected on the
 *   first inbound chunk; otherwise falls back to newline-delimited JSON.
 * - Forwards stderr from the child to our stderr so Claude Desktop's logs
 *   still surface server errors.
 * - Never holds a JSON-RPC frame open longer than necessary: when the
 *   user denies a call we synthesize the error response immediately.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { evaluate } from "./policy";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown; [k: string]: unknown };
}

export interface ProxyConfig {
  /** Logical name reported to the policy engine, e.g. "filesystem". */
  serverName: string;
  /** Real server executable (Claude Desktop normally configures this). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ProxyStreams {
  /** Inbound from Claude Desktop. */
  clientIn: Readable;
  /** Outbound to Claude Desktop. */
  clientOut: Writable;
  /** Optional log sink. */
  log?: Writable;
}

/**
 * Run the proxy until the child exits. Resolves with the child's exit code.
 * Streams default to `process.stdin/stdout/stderr` for use as a CLI bin.
 */
export async function runProxy(
  config: ProxyConfig,
  streams: Partial<ProxyStreams> = {},
): Promise<number> {
  const clientIn = streams.clientIn ?? process.stdin;
  const clientOut = streams.clientOut ?? process.stdout;
  const logOut = streams.log ?? process.stderr;

  const child = spawn(config.command, config.args ?? [], {
    env: { ...process.env, ...config.env },
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.pipe(logOut, { end: false });

  const sender = new FrameSender(clientOut);
  const childSender = new FrameSender(child.stdin);

  // child → client: forward unconditionally.
  parseFrames(child.stdout, (frame) => {
    sender.sendRaw(frame);
  });

  // client → child: intercept tools/call.
  parseFrames(clientIn, async (frame) => {
    let req: JsonRpcRequest | null = null;
    try {
      req = JSON.parse(frame.toString("utf8")) as JsonRpcRequest;
    } catch {
      // not JSON — forward unchanged
      childSender.sendRaw(frame);
      return;
    }

    if (req?.method === "tools/call") {
      const toolName = String(req.params?.name ?? "");
      const args = req.params?.arguments;
      try {
        const result = await evaluate(
          { serverName: config.serverName, toolName, args },
          req.id ?? null,
        );
        if (result.decision === "deny") {
          // Send synthetic JSON-RPC error back to client; do not forward.
          sender.sendJson({
            jsonrpc: "2.0",
            id: req.id ?? null,
            error: {
              code: -32000,
              message: `blocked by Whitehat policy: ${result.reason}`,
              data: { invocationHash: result.invocationHash },
            },
          });
          return;
        }
      } catch (err) {
        sender.sendJson({
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: {
            code: -32001,
            message: `Whitehat policy error: ${(err as Error).message}`,
          },
        });
        return;
      }
    }

    childSender.sendRaw(frame);
  });

  return new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

// -----------------------------------------------------------------------------
// Frame parser — supports `Content-Length` (LSP-style) and NDJSON.
// -----------------------------------------------------------------------------

type FrameMode = "unknown" | "lsp" | "ndjson";

function parseFrames(
  source: Readable,
  onFrame: (frame: Buffer) => void,
): void {
  let mode: FrameMode = "unknown";
  let buf = Buffer.alloc(0);

  source.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (mode === "unknown") {
      mode = buf.toString("utf8", 0, Math.min(buf.length, 32))
        .toLowerCase()
        .startsWith("content-length:")
        ? "lsp"
        : "ndjson";
    }
    if (mode === "lsp") drainLsp();
    else drainNdjson();
  });

  function drainNdjson() {
    let nl: number;
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (line.length > 0) onFrame(line);
    }
  }

  function drainLsp() {
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buf.subarray(0, headerEnd).toString("utf8");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // malformed; drop the header
        buf = buf.subarray(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const total = headerEnd + 4 + len;
      if (buf.length < total) return;
      const body = buf.subarray(headerEnd + 4, total);
      buf = buf.subarray(total);
      onFrame(body);
    }
  }
}

class FrameSender {
  private mode: FrameMode = "unknown";
  constructor(private out: Writable) {}

  sendRaw(body: Buffer): void {
    if (this.mode === "unknown") this.mode = "ndjson";
    if (this.mode === "lsp") {
      this.out.write(`Content-Length: ${body.length}\r\n\r\n`);
      this.out.write(body);
    } else {
      this.out.write(body);
      if (body[body.length - 1] !== 0x0a) this.out.write("\n");
    }
  }

  sendJson(obj: unknown): void {
    this.sendRaw(Buffer.from(JSON.stringify(obj), "utf8"));
  }
}
