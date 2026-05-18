/**
 * Image Studio — AI image generation, editing, and management
 *
 * The heavy lifting (provider/model picker, generation, mask editor,
 * gallery, upscale, variations, publish) lives in
 * `src/components/image-studio/ImageStudioTab.tsx`. This page is a thin
 * shell that keeps the route header + cross-studio Publish button while
 * delegating the full UX to the real, IPC-wired component.
 */

import { ImageIcon } from "lucide-react";
import { ImageStudioTab } from "@/components/image-studio/ImageStudioTab";
import PublishToMarketplaceButton from "@/components/joy/PublishToMarketplaceButton";

export default function ImageStudioPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="border-b p-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center">
            <ImageIcon className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold">Image Studio</h1>
            <p className="text-sm text-muted-foreground">
              AI image generation, editing, and management
            </p>
          </div>
          <PublishToMarketplaceButton assetType="image" studio="image_studio" />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <ImageStudioTab />
      </div>
    </div>
  );
}
