/**
 * MCP discovery tools — search_mcp_tools + get_mcp_tool_schema.
 *
 * JoyCreate exposes a large catalog of MCP/integration tools (apps, agents,
 * datasets, images, video, marketplace, workflows, plus any external MCP
 * servers the user connected). Rather than force the model to scan every tool
 * schema, these two tools let it discover capabilities on demand:
 *
 *   - search_mcp_tools(query): keyword-search the catalog, returns matching
 *     tool names + one-line descriptions (cheap, no schemas).
 *   - get_mcp_tool_schema(name): fetch the full input schema for one tool so
 *     the model knows exactly how to call it.
 *
 * This keeps the context lean while making the entire MCP surface reachable.
 */

import { z } from "zod";
import type { ZodTypeAny } from "zod";
import { ToolDefinition, escapeXmlContent } from "./types";
import { getMcpAgentTools } from "./mcp_tools_adapter";
import { getExternalMcpAgentTools } from "./mcp_external_tools_adapter";

/** Aggregate the MCP-derived catalog (internal curated + external servers). */
async function getMcpCatalog(): Promise<ToolDefinition[]> {
  const [internal, external] = await Promise.all([
    Promise.resolve().then(() => getMcpAgentTools()).catch(() => []),
    getExternalMcpAgentTools().catch(() => []),
  ]);
  const byName = new Map<string, ToolDefinition>();
  for (const t of [...internal, ...external]) byName.set(t.name, t);
  return Array.from(byName.values());
}

/**
 * Produce a readable JSON-ish description of a zod object schema without
 * pulling in a heavy converter. Handles the common ZodObject-of-primitives
 * shape used by the tool definitions; degrades gracefully for anything else.
 */
function describeSchema(schema: ZodTypeAny): Record<string, unknown> | string {
  const def = (schema as { _def?: { typeName?: string } })._def;
  if (!def || def.typeName !== "ZodObject") {
    return "object";
  }
  const shape =
    typeof (schema as { shape?: unknown }).shape === "object"
      ? ((schema as { shape: Record<string, ZodTypeAny> }).shape ?? {})
      : {};
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    fields[key] = describeField(field);
  }
  return fields;
}

function unwrap(field: ZodTypeAny): {
  inner: ZodTypeAny;
  optional: boolean;
} {
  let inner = field;
  let optional = false;
  // Peel Optional/Nullable/Default wrappers.
  for (let i = 0; i < 5; i++) {
    const tn = (inner as { _def?: { typeName?: string; innerType?: ZodTypeAny } })
      ._def;
    if (!tn) break;
    if (
      tn.typeName === "ZodOptional" ||
      tn.typeName === "ZodNullable" ||
      tn.typeName === "ZodDefault"
    ) {
      if (tn.typeName !== "ZodDefault") optional = true;
      if (tn.innerType) {
        inner = tn.innerType;
        continue;
      }
    }
    break;
  }
  return { inner, optional };
}

function describeField(field: ZodTypeAny): string {
  const { inner, optional } = unwrap(field);
  const def = (inner as {
    _def?: { typeName?: string; values?: unknown; description?: string };
  })._def;
  const description =
    (field as { description?: string }).description ??
    (inner as { description?: string }).description;

  let type = "unknown";
  switch (def?.typeName) {
    case "ZodString":
      type = "string";
      break;
    case "ZodNumber":
      type = "number";
      break;
    case "ZodBoolean":
      type = "boolean";
      break;
    case "ZodArray":
      type = "array";
      break;
    case "ZodObject":
      type = "object";
      break;
    case "ZodEnum":
      type = `enum(${
        Array.isArray((def as { values?: string[] }).values)
          ? (def as { values: string[] }).values.join("|")
          : ""
      })`;
      break;
    case "ZodRecord":
      type = "record";
      break;
    default:
      type = def?.typeName?.replace(/^Zod/, "").toLowerCase() ?? "unknown";
  }

  const parts = [type];
  if (optional) parts.push("optional");
  if (description) parts.push(`— ${description}`);
  return parts.join(" ");
}

// ── search_mcp_tools ────────────────────────────────────────────────────────

const searchMcpToolsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Keywords describing the capability you need (e.g. 'generate image', 'publish dataset', 'run workflow').",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(30)
    .optional()
    .describe("Max number of matching tools to return (default 12)."),
});

export const searchMcpToolsTool: ToolDefinition<
  z.infer<typeof searchMcpToolsSchema>
> = {
  name: "search_mcp_tools",
  description: `Search the MCP/integration tool catalog (apps, agents, datasets, images, video, marketplace, workflows, and connected external MCP servers) by keyword.
Use this to discover a capability without scanning every tool. Returns matching tool names + short descriptions.
Follow up with get_mcp_tool_schema to see how to call a specific tool.`,
  inputSchema: searchMcpToolsSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Search MCP tools: ${args.query}`,

  buildXml: (args, isComplete) => {
    let xml = `<joy-output type="mcp-search">${escapeXmlContent(args.query ?? "")}`;
    if (isComplete) xml += "</joy-output>";
    return xml;
  },

  execute: async (args) => {
    const catalog = await getMcpCatalog();
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    const limit = args.limit ?? 12;

    const scored = catalog
      .map((t) => {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (haystack.includes(term)) score += 1;
          if (t.name.toLowerCase().includes(term)) score += 1;
        }
        return { tool: t, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) {
      return `No MCP tools matched "${args.query}". The catalog has ${catalog.length} tools; try broader keywords.`;
    }

    const formatted = scored
      .map(
        ({ tool }) =>
          `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim().slice(0, 160)}`,
      )
      .join("\n");

    return escapeXmlContent(
      `Found ${scored.length} MCP tool(s) matching "${args.query}":\n\n${formatted}\n\nUse get_mcp_tool_schema("<name>") to see how to call one.`,
    );
  },
};

// ── get_mcp_tool_schema ─────────────────────────────────────────────────────

const getMcpToolSchemaSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("The exact tool name (from search_mcp_tools) to inspect."),
});

export const getMcpToolSchemaTool: ToolDefinition<
  z.infer<typeof getMcpToolSchemaSchema>
> = {
  name: "get_mcp_tool_schema",
  description: `Get the input schema and description for a specific MCP/integration tool (discovered via search_mcp_tools).
Returns the parameters, their types, and which are required — so you can call the tool correctly.`,
  inputSchema: getMcpToolSchemaSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Get schema: ${args.name}`,

  buildXml: (args, isComplete) => {
    let xml = `<joy-output type="mcp-schema">${escapeXmlContent(args.name ?? "")}`;
    if (isComplete) xml += "</joy-output>";
    return xml;
  },

  execute: async (args) => {
    const catalog = await getMcpCatalog();
    const tool = catalog.find((t) => t.name === args.name);
    if (!tool) {
      const suggestion = catalog
        .filter((t) => t.name.includes(args.name) || args.name.includes(t.name))
        .slice(0, 5)
        .map((t) => t.name);
      return `No MCP tool named "${args.name}". ${
        suggestion.length > 0
          ? `Did you mean: ${suggestion.join(", ")}?`
          : "Use search_mcp_tools to find the correct name."
      }`;
    }

    const schema = describeSchema(tool.inputSchema as ZodTypeAny);
    const payload = {
      name: tool.name,
      description: tool.description,
      requiresConsent: tool.defaultConsent === "ask",
      parameters: schema,
    };

    return escapeXmlContent(JSON.stringify(payload, null, 2));
  },
};
