/**
 * MCP Tools — LibreOffice document studio.
 *
 * Routed through the registered `libreoffice:*` IPC channels. These previously
 * required `LibreOfficeManager` off an alias path — the export exists, but the
 * bundled runtime could not resolve the specifier, so every call failed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";

/**
 * `DocumentContent` is a structured `{ sections: [...] }` document, not a
 * string. An MCP caller should not have to know that, so plain `text` is
 * accepted and split into paragraphs here. A blank line starts a new section.
 */
function textToContent(title: string, text?: string) {
  if (!text) return undefined;
  const sections = text
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => ({ type: "paragraph" as const, content: para }));
  return { title, sections };
}

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "joycreate_list_documents",
    {
      description: "List documents in the JoyCreate document studio.",
      inputSchema: {
        limit: z.number().optional().describe("Max results"),
      },
    },
    async (params) => runTool("joycreate_list_documents", () =>
      invokeHandler("libreoffice:list", params)),
  );

  server.registerTool(
    "joycreate_create_document",
    {
      description:
        "Create a document, spreadsheet or presentation. Writes a native ODF file — " +
        "LibreOffice is only needed to convert to other formats, not to create. " +
        "Supply `text` for a simple document, or `prompt` to have AI generate the " +
        "contents.",
      inputSchema: {
        name: z.string().describe("Document name"),
        type: z
          .enum(["document", "spreadsheet", "presentation"])
          .optional()
          .describe("What to create. Default 'document'."),
        format: z
          .string()
          .optional()
          .describe("Output format, e.g. odt, docx, ods, xlsx, odp, pptx. Defaults per type."),
        text: z
          .string()
          .optional()
          .describe("Body text. Blank lines separate paragraphs."),
        prompt: z
          .string()
          .optional()
          .describe("Generate the document with AI from this prompt instead of `text`."),
      },
    },
    async (params) =>
      runTool("joycreate_create_document", async () => {
        const res = await invokeHandler("libreoffice:create", {
          name: params.name,
          type: params.type ?? "document",
          format: params.format,
          content: textToContent(params.name, params.text),
          aiGenerate: params.prompt ? { prompt: params.prompt } : undefined,
        });
        // The manager reports failure in-band as `{ success: false, error }`.
        // Left alone that reads as a successful tool call whose payload happens
        // to mention an error — exactly what hid the broken content shape.
        if (res && res.success === false) {
          throw new Error(res.error ?? "Document creation failed");
        }
        return res;
      }),
  );

  server.registerTool(
    "joycreate_export_document",
    {
      description:
        "Export a document to another format (pdf, docx, xlsx, pptx, …). Requires " +
        "LibreOffice — check joycreate_libreoffice_status first.",
      inputSchema: {
        documentId: z.number().describe("Document id to export"),
        format: z.string().describe("Target format, e.g. pdf, docx, xlsx, pptx"),
      },
    },
    async (params) =>
      runTool("joycreate_export_document", async () => {
        // ExportDocumentRequest keys this `documentId`, not `id` — sending the
        // wrong name surfaced as a plain "Document not found".
        const res = await invokeHandler("libreoffice:export", {
          documentId: params.documentId,
          format: params.format,
        });
        if (res && res.success === false) {
          throw new Error(res.error ?? "Export failed");
        }
        return res;
      }),
  );

  server.registerTool(
    "joycreate_libreoffice_status",
    {
      description:
        "Whether LibreOffice is installed and ready. Creating documents does not " +
        "need it; converting between formats does.",
      inputSchema: {},
    },
    async () => runTool("joycreate_libreoffice_status", () =>
      invokeHandler("libreoffice:status")),
  );

  void toolError;
}
