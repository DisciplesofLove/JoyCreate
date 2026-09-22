/**
 * execute_sandbox_script tool — Run an ephemeral, inline script in the app's
 * project directory without persisting a file.
 *
 * This complements run_command: instead of a single shell line, the agent can
 * author a multi-line Node/Python/Bash/PowerShell script (e.g. a data
 * transform, a codemod, a scaffolding routine), run it once, capture the
 * output, and have the temp file auto-deleted. Every run requires explicit
 * user approval (consent: "ask").
 */

import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("execute_sandbox_script");

const LANGUAGES = ["node", "python", "bash", "powershell"] as const;
type Language = (typeof LANGUAGES)[number];

const LANGUAGE_CONFIG: Record<
  Language,
  { ext: string; command: (file: string) => string }
> = {
  node: { ext: "mjs", command: (f) => `node "${f}"` },
  python: {
    ext: "py",
    command: (f) =>
      `${process.platform === "win32" ? "python" : "python3"} "${f}"`,
  },
  bash: { ext: "sh", command: (f) => `bash "${f}"` },
  powershell: {
    ext: "ps1",
    command: (f) => `powershell -ExecutionPolicy Bypass -File "${f}"`,
  },
};

/** Defense-in-depth: block obviously destructive operations. Consent is the primary gate. */
const BLOCKED_PATTERNS = [
  /\brm\s+(-rf?|--recursive)\s+[/\\]/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\//i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\breg\s+(delete|add)\b/i,
  /rmdir\s+\/s/i,
  /Remove-Item.*-Recurse.*-Force.*[A-Z]:\\/i,
];

const executeSandboxScriptSchema = z.object({
  script: z.string().min(1).describe("The full script source to execute."),
  language: z
    .enum(LANGUAGES)
    .optional()
    .describe("Script language: node (default), python, bash, or powershell."),
  timeout_ms: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (default: 30000, max: 120000)."),
});

export const executeSandboxScriptTool: ToolDefinition<
  z.infer<typeof executeSandboxScriptSchema>
> = {
  name: "execute_sandbox_script",
  description: `Run an ephemeral, inline script in the app's project directory and get its output.
Use this for one-off multi-line logic that doesn't belong in the codebase:
- Data transformations / migrations of local files
- Codemods across many files
- Generating fixtures or seed data
- Quick computations or checks that need real code

Supported languages: node (default), python, bash, powershell. The script runs with the app directory as cwd, is NOT saved to the project, and is deleted after running. Output (stdout + stderr) is captured, max 10000 chars. Every run requires explicit user approval.`,
  inputSchema: executeSandboxScriptSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) =>
    `Run ${args.language ?? "node"} sandbox script (${
      (args.script ?? "").split("\n").length
    } lines)`,

  buildXml: (args, isComplete) => {
    if (!args.script) return undefined;
    const lang = args.language ?? "node";
    let xml = `<joy-run-command directory="sandbox:${escapeXmlAttr(lang)}">\n${escapeXmlContent(
      args.script,
    )}`;
    if (isComplete) {
      xml += "\n</joy-run-command>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const { script, timeout_ms } = args;
    const language: Language = args.language ?? "node";

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(script)) {
        throw new Error(
          `Sandbox script blocked for safety: matches a restricted pattern (${pattern}).`,
        );
      }
    }

    const config = LANGUAGE_CONFIG[language];
    const tempFile = path.join(
      os.tmpdir(),
      `joy-sandbox-${randomUUID()}.${config.ext}`,
    );
    fs.writeFileSync(tempFile, script, "utf8");

    const timeout = Math.min(timeout_ms ?? 30_000, 120_000);
    logger.info(
      `Executing ${language} sandbox script in ${ctx.appPath} (timeout: ${timeout}ms)`,
    );

    try {
      return await new Promise<string>((resolve) => {
        exec(
          config.command(tempFile),
          {
            cwd: ctx.appPath,
            timeout,
            maxBuffer: 1024 * 1024,
            shell:
              process.platform === "win32" ? "powershell.exe" : "/bin/sh",
            env: {
              ...process.env,
              CI: "true",
              NO_COLOR: "1",
            },
          },
          (error, stdout, stderr) => {
            const parts: string[] = [];
            if (stdout) parts.push(stdout.toString());
            if (stderr) parts.push(`[stderr]\n${stderr.toString()}`);
            if (error) {
              const killed = (error as { killed?: boolean }).killed;
              parts.push(
                killed
                  ? `[error] Script timed out after ${timeout}ms.`
                  : `[error] Exit code ${error.code ?? "unknown"}: ${error.message}`,
              );
            }
            let output = parts.join("\n").trim() || "(no output)";
            if (output.length > 10_000) {
              output = `${output.slice(0, 10_000)}\n…(truncated)`;
            }
            resolve(escapeXmlContent(output));
          },
        );
      });
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch (cleanupError) {
        logger.warn(`Failed to remove sandbox temp file: ${cleanupError}`);
      }
    }
  },
};
