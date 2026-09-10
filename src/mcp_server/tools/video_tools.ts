/**
 * MCP Tools — Video Studio and the media pipeline.
 *
 * Routed through the registered `video-studio:*` and `media-pipeline:*` IPC
 * channels rather than non-existent module exports.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invokeHandler, runTool, toolError } from "./invoke_handler";
import {
  VIDEO_PROVIDERS,
  defaultModelFor,
} from "@/lib/media/provider_defaults";

// Shared with the autonomous action catalog — see provider_defaults.
const VIDEO_PROVIDER = z.enum(VIDEO_PROVIDERS);

export function registerVideoTools(server: McpServer) {
  server.registerTool(
    "joycreate_video_generate",
    {
      description:
        "Generate a video with JoyCreate Video Studio. Returns the saved video path " +
        "and metadata.",
      inputSchema: {
        prompt: z.string().describe("Video generation prompt"),
        provider: VIDEO_PROVIDER.describe(
          "Which backend renders the video. Required — the handler has no default.",
        ),
        model: z.string().optional().describe("Model id for that provider"),
        negative_prompt: z.string().optional().describe("What to exclude"),
        duration: z.number().optional().describe("Duration in seconds (default 5)"),
        fps: z.number().optional().describe("Frames per second (default 24)"),
        width: z.number().optional().describe("Width in pixels"),
        height: z.number().optional().describe("Height in pixels"),
        seed: z.number().optional().describe("Seed, for reproducibility"),
        style: z.string().optional().describe("Style preset"),
      },
    },
    async (params) =>
      runTool("joycreate_video_generate", () =>
        // Same defect the image tool had: `provider` is required by the handler
        // and was never exposed here, so every call failed on "Provider is
        // required" before rendering anything. `model` and the camelCase
        // parameter names have to be mapped explicitly too.
        invokeHandler("video-studio:generate", {
          provider: params.provider,
          model: params.model ?? defaultModelFor(params.provider, "video"),
          prompt: params.prompt,
          negativePrompt: params.negative_prompt,
          width: params.width ?? 1024,
          height: params.height ?? 576,
          duration: params.duration,
          fps: params.fps,
          seed: params.seed === undefined ? undefined : String(params.seed),
          style: params.style,
        }),
      ),
  );

  server.registerTool(
    "joycreate_video_process",
    {
      description:
        "Process an existing video file — transcode, trim, or resize — through the " +
        "media pipeline. Requires ffmpeg on PATH; check joycreate_media_tools first.",
      inputSchema: {
        inputPath: z.string().describe("Absolute path to the source video"),
        outputPath: z.string().optional().describe("Destination path"),
        options: z
          .record(z.any())
          .describe("VideoProcessOptions, e.g. { format: 'mp4', width: 1280, trim: {...} }"),
      },
    },
    async (params) => runTool("joycreate_video_process", () =>
      invokeHandler("media-pipeline:process-video", {
        inputPath: params.inputPath,
        outputPath: params.outputPath,
        options: params.options ?? {},
      })),
  );

  server.registerTool(
    "joycreate_media_pipeline",
    {
      description:
        "Run a batch media pipeline job. Each entry names a file, its media type, and " +
        "the options for that type.",
      inputSchema: {
        files: z
          .array(
            z.object({
              inputPath: z.string(),
              type: z.enum(["image", "audio", "video"]),
              options: z.record(z.any()).optional(),
            }),
          )
          .describe("Files to process"),
        outputDir: z.string().optional().describe("Where to write results"),
      },
    },
    async (params) => runTool("joycreate_media_pipeline", () =>
      invokeHandler("media-pipeline:batch-process", {
        files: (params.files ?? []).map((f) => ({ ...f, options: f.options ?? {} })),
        outputDir: params.outputDir,
      })),
  );

  server.registerTool(
    "joycreate_media_tools",
    {
      description:
        "Report which media tools (ffmpeg, ImageMagick, …) are available. Video and " +
        "audio processing need them; this says what will actually run.",
      inputSchema: {},
    },
    async () => runTool("joycreate_media_tools", () =>
      invokeHandler("media-pipeline:check-tools")),
  );
}
