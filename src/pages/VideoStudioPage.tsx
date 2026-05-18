/**
 * Video Studio — AI video generation, editing, and management
 *
 * The full provider/model picker, generation pipeline, FFmpeg-backed
 * trim/merge/transition tools, gallery, and publish flow live in
 * `src/components/video-studio/VideoStudioTab.tsx`. This page is a thin
 * route shell that keeps the page header + cross-studio Publish button
 * and embeds the real, IPC-wired component.
 */

import { Video } from "lucide-react";
import { VideoStudioTab } from "@/components/video-studio/VideoStudioTab";
import PublishToMarketplaceButton from "@/components/joy/PublishToMarketplaceButton";

export default function VideoStudioPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="border-b p-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center">
            <Video className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold">Video Studio</h1>
            <p className="text-sm text-muted-foreground">
              AI video generation, editing, and management
            </p>
          </div>
          <PublishToMarketplaceButton assetType="video" studio="video_studio" />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <VideoStudioTab />
      </div>
    </div>
  );
}
