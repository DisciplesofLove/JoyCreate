/**
 * Scheduler task dispatch for the social suite.
 *
 * The scheduler fires generic `{ toolName, args }` actions. `runSocialTask`
 * maps the `social.*` tool names to their concrete implementations. Wired into
 * the headless tool dispatcher in `tools_handlers.ts`.
 */

import { syncAllEngagements } from "./engagement_sync";
import { publishPost } from "./publisher";
import {
  autoReplyPass,
  generateForCampaign,
  runAgentTick,
} from "./social_agent";

/** True when a tool name belongs to the social suite. */
export function isSocialTask(toolName: string): boolean {
  return toolName.startsWith("social.");
}

export async function runSocialTask(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "social.post": {
      const postId = Number(args.postId);
      if (!Number.isFinite(postId)) {
        throw new Error("social.post requires a numeric { postId }.");
      }
      return publishPost(postId);
    }
    case "social.campaign.generate": {
      const campaignId = Number(args.campaignId);
      if (!Number.isFinite(campaignId)) {
        throw new Error(
          "social.campaign.generate requires a numeric { campaignId }.",
        );
      }
      return generateForCampaign(campaignId);
    }
    case "social.engagement.scan": {
      const scan = await syncAllEngagements();
      const replies = await autoReplyPass();
      return { ...scan, replies };
    }
    case "social.agent.tick":
      return runAgentTick();
    default:
      throw new Error(`Unknown social task: ${toolName}`);
  }
}
