/**
 * Podcast briefing IPC handlers.
 *
 * Channels:
 *   - podcast:generate-briefing  (title, segments, defaultVoice) \u2192 BriefingResult
 *
 * Designed to be a one-call \"morning briefing\" pipeline that an agent or the
 * scheduler can invoke without any UI state.
 */

import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import {
  packageBriefing,
  type BriefingSegment,
  type BriefingResult,
  type PackageBriefingInput,
} from "../../lib/podcast/briefing_packager";

const logger = log.scope("podcast_handlers");
const handle = createLoggedHandler(logger);

export function registerPodcastHandlers(): void {
  handle(
    "podcast:generate-briefing",
    async (_event, params: PackageBriefingInput): Promise<BriefingResult> => {
      if (!params || typeof params !== "object") {
        throw new Error("podcast:generate-briefing requires a params object.");
      }
      if (!params.title || typeof params.title !== "string") {
        throw new Error("Briefing requires a non-empty title.");
      }
      if (!Array.isArray(params.segments) || params.segments.length === 0) {
        throw new Error("Briefing requires at least one segment.");
      }
      const segments: BriefingSegment[] = params.segments.map((s, idx) => {
        if (!s || typeof s.text !== "string" || s.text.trim().length === 0) {
          throw new Error(
            `Segment ${idx} is missing required \`text\` content.`,
          );
        }
        return {
          speaker: typeof s.speaker === "string" ? s.speaker : undefined,
          text: s.text,
          voice: typeof s.voice === "string" ? s.voice : undefined,
          speed: typeof s.speed === "number" ? s.speed : undefined,
        };
      });
      return packageBriefing({
        title: params.title,
        defaultVoice: params.defaultVoice,
        segments,
      });
    },
  );
}
