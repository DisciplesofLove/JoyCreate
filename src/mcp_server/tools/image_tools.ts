/**
 * MCP Tools — Image Studio.
 *
 * Routed through the registered `image-studio:*` IPC channels. These used to
 * `require("@/ipc/handlers/image_studio_handlers")` for functions that were
 * never exported, on an alias the bundler does not resolve at runtime.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";
import {
  IMAGE_PROVIDERS,
  defaultModelFor,
} from "@/lib/media/provider_defaults";

// Provider names and default models are shared with the autonomous action
// catalog, which dispatches the same two handlers. Keeping two copies is how
// they drifted apart in the first place — the catalog advertised "stability"
// and "local", neither of which the handler accepts.
const IMAGE_PROVIDER = z.enum(IMAGE_PROVIDERS);

export function registerImageTools(server: McpServer) {
  server.registerTool(
    "joycreate_image_generate",
    {
      description:
        "Generate an image with JoyCreate Image Studio. Supports local diffusion models " +
        "and remote providers. Returns the saved image path and metadata.",
      inputSchema: {
        prompt: z.string().describe("Image generation prompt"),
        provider: IMAGE_PROVIDER.describe(
          "Which backend renders the image. Required — the handler has no default.",
        ),
        model: z
          .string()
          .optional()
          .describe("Model id for that provider, e.g. dall-e-3, sdxl, flux"),
        negative_prompt: z.string().optional().describe("What to exclude"),
        width: z.number().optional().describe("Width in pixels (default 1024)"),
        height: z.number().optional().describe("Height in pixels (default 1024)"),
        steps: z.number().optional().describe("Inference steps"),
        guidance_scale: z.number().optional().describe("CFG guidance scale"),
        seed: z.number().optional().describe("Seed, for reproducibility"),
        style: z.string().optional().describe("Style preset"),
        batchCount: z.number().optional().describe("Images to render, 1-4"),
      },
    },
    async (params) =>
      runTool("joycreate_image_generate", () =>
        // The handler's parameter names differ from the tool's snake_case ones,
        // and it requires `provider` and `model`. Passing `params` straight
        // through — as this did — meant every call failed on "Provider is
        // required", and had it got past that, `negative_prompt`,
        // `guidance_scale` and a numeric `seed` would all have been dropped on
        // the floor, silently ignoring what the caller asked for.
        invokeHandler("image-studio:generate", {
          provider: params.provider,
          model: params.model ?? defaultModelFor(params.provider, "image"),
          prompt: params.prompt,
          negativePrompt: params.negative_prompt,
          width: params.width ?? 1024,
          height: params.height ?? 1024,
          steps: params.steps,
          cfgScale: params.guidance_scale,
          seed: params.seed === undefined ? undefined : String(params.seed),
          style: params.style,
          batchCount: params.batchCount,
        }),
      ),
  );

  server.registerTool(
    "joycreate_image_list",
    {
      description: "List images generated or imported in JoyCreate Image Studio.",
      inputSchema: {
        limit: z.number().optional().describe("Max results"),
        search: z.string().optional().describe("Filter by prompt or filename"),
      },
    },
    async (params) => runTool("joycreate_image_list", () =>
      invokeHandler("image-studio:list", params)),
  );
}
