/**
 * preview_engine — pure frame resolver.
 *
 * Proves the multi-track compositor's draw plan: which video clips / overlays
 * are visible at a given playhead, their speed-adjusted source time, crossfade
 * opacity ramps, overlay fades, and z-ordering (overlays above video).
 */

import { describe, it, expect } from "vitest";

import {
  clipSourceTime,
  resolveFrameLayers,
  type FrameLayer,
  type OverlayFrameLayer,
  type VideoFrameLayer,
} from "@/lib/video/preview_engine";
import type {
  VideoClipV2,
  VideoTimelineV2,
} from "@/lib/video/timeline_v2";

function clip(p: Partial<VideoClipV2> & { id: string }): VideoClipV2 {
  return { videoId: 1, timelineStart: 0, trimStart: 0, trimEnd: 10, ...p };
}

function timeline(tracks: VideoTimelineV2["tracks"]): VideoTimelineV2 {
  return { version: 2, width: 1280, height: 720, fps: 30, tracks, markers: [] };
}

function videoLayers(layers: FrameLayer[]): VideoFrameLayer[] {
  return layers.filter((l): l is VideoFrameLayer => l.kind === "video");
}
function overlayLayers(layers: FrameLayer[]): OverlayFrameLayer[] {
  return layers.filter((l): l is OverlayFrameLayer => l.kind === "overlay");
}

describe("clipSourceTime", () => {
  it("maps timeline time to source time accounting for trim + speed", () => {
    expect(clipSourceTime(clip({ id: "a", timelineStart: 2, trimStart: 1 }), 4)).toBeCloseTo(3);
    expect(
      clipSourceTime(clip({ id: "a", timelineStart: 0, trimStart: 0, speed: 2 }), 3),
    ).toBeCloseTo(6);
  });
});

describe("resolveFrameLayers — visibility", () => {
  it("returns the clip active at the playhead", () => {
    const t = timeline([
      { id: "vt", kind: "video", clips: [clip({ id: "a", timelineStart: 0, trimEnd: 5 })] },
    ]);
    const layers = videoLayers(resolveFrameLayers(t, 2));
    expect(layers).toHaveLength(1);
    expect(layers[0].clipId).toBe("a");
    expect(layers[0].opacity).toBeCloseTo(1);
  });

  it("returns nothing in a gap", () => {
    const t = timeline([
      { id: "vt", kind: "video", clips: [clip({ id: "a", timelineStart: 0, trimEnd: 3 })] },
    ]);
    expect(resolveFrameLayers(t, 10)).toHaveLength(0);
  });

  it("skips muted tracks", () => {
    const t = timeline([
      { id: "vt", kind: "video", muted: true, clips: [clip({ id: "a", trimEnd: 5 })] },
    ]);
    expect(resolveFrameLayers(t, 1)).toHaveLength(0);
  });
});

describe("resolveFrameLayers — crossfade", () => {
  it("renders both clips during a transition with complementary opacity", () => {
    // clip a: 0..5 with 1s transition into b; b starts at 4 (butted with overlap)
    const a = clip({
      id: "a",
      timelineStart: 0,
      trimStart: 0,
      trimEnd: 5,
      transitionToNext: { type: "fade", duration: 1 },
    });
    const b = clip({ id: "b", timelineStart: 4, trimStart: 0, trimEnd: 5 });
    const t = timeline([{ id: "vt", kind: "video", clips: [a, b] }]);

    // At time 4.5 (mid-transition): a fading out, b fading in.
    const layers = videoLayers(resolveFrameLayers(t, 4.5));
    expect(layers.map((l) => l.clipId).sort()).toEqual(["a", "b"]);
    const opA = layers.find((l) => l.clipId === "a")!.opacity;
    const opB = layers.find((l) => l.clipId === "b")!.opacity;
    expect(opA).toBeCloseTo(0.5);
    expect(opB).toBeCloseTo(0.5);
  });
});

describe("resolveFrameLayers — overlays", () => {
  it("includes overlays above video and ramps fade-in opacity", () => {
    const t = timeline([
      { id: "vt", kind: "video", clips: [clip({ id: "a", timelineStart: 0, trimEnd: 10 })] },
      {
        id: "ot",
        kind: "overlay",
        items: [
          { id: "o1", pngBase64: "x", start: 1, end: 5, fadeIn: 1, fadeOut: 1 },
        ],
      },
    ]);
    const layers = resolveFrameLayers(t, 1.5);
    const ovs = overlayLayers(layers);
    expect(ovs).toHaveLength(1);
    expect(ovs[0].opacity).toBeCloseTo(0.5);
    // Overlay must sort to the front (drawn last): lowest z value.
    expect(layers[layers.length - 1].kind).toBe("overlay");
  });

  it("ramps fade-out opacity near the end", () => {
    const t = timeline([
      {
        id: "ot",
        kind: "overlay",
        items: [{ id: "o1", pngBase64: "x", start: 0, end: 4, fadeOut: 2 }],
      },
    ]);
    const ovs = overlayLayers(resolveFrameLayers(t, 3));
    expect(ovs[0].opacity).toBeCloseTo(0.5);
  });
});

describe("resolveFrameLayers — z-order across video tracks", () => {
  it("stacks earlier video tracks on top (drawn last)", () => {
    const t = timeline([
      { id: "top", kind: "video", clips: [clip({ id: "a", trimEnd: 10 })] },
      { id: "bottom", kind: "video", clips: [clip({ id: "b", trimEnd: 10 })] },
    ]);
    const layers = videoLayers(resolveFrameLayers(t, 1));
    // Back-to-front: bottom track first, top track last.
    expect(layers[0].trackId).toBe("bottom");
    expect(layers[layers.length - 1].trackId).toBe("top");
  });
});
