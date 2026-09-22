/**
 * timeline_v2 — multi-track timeline model.
 *
 * Proves the pure edit operations (migration, split, ripple/plain delete,
 * move, trim, snap) are immutable and produce the expected positioned-clip
 * geometry, and that the v1<->v2 bridge round-trips render-compatible docs.
 */

import { describe, it, expect } from "vitest";

import type { VideoTimeline } from "@/lib/video/timeline_types";
import {
  addTrack,
  audioClipDuration,
  createEmptyTimelineV2,
  deleteClip,
  migrateTimeline,
  moveClip,
  resolveSnap,
  rippleDeleteClip,
  snapCandidates,
  splitClipAt,
  timelineDurationV2,
  toLegacyTimeline,
  trimClip,
  videoClipDuration,
  type AudioTrackV2,
  type VideoClipV2,
  type VideoTimelineV2,
  type VideoTrackV2,
} from "@/lib/video/timeline_v2";

const EPS = 1e-6;

/** Build a v2 timeline with a single video track of positioned clips. */
function videoTimeline(clips: VideoClipV2[]): VideoTimelineV2 {
  return {
    version: 2,
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [{ id: "vt", kind: "video", name: "Video 1", clips }],
    markers: [],
  };
}

function clip(partial: Partial<VideoClipV2> & { id: string }): VideoClipV2 {
  return {
    videoId: 1,
    timelineStart: 0,
    trimStart: 0,
    trimEnd: 10,
    ...partial,
  };
}

function videoTrack(t: VideoTimelineV2): VideoTrackV2 {
  return t.tracks.find((x): x is VideoTrackV2 => x.kind === "video")!;
}

describe("createEmptyTimelineV2", () => {
  it("creates a video, audio, and overlay track", () => {
    const t = createEmptyTimelineV2();
    expect(t.version).toBe(2);
    expect(t.tracks.map((x) => x.kind)).toEqual(["video", "audio", "overlay"]);
  });
});

describe("durations", () => {
  it("video clip duration honors trim window and speed", () => {
    expect(videoClipDuration(clip({ id: "a", trimStart: 2, trimEnd: 12 }))).toBeCloseTo(10);
    expect(
      videoClipDuration(clip({ id: "a", trimStart: 0, trimEnd: 10, speed: 2 })),
    ).toBeCloseTo(5);
  });

  it("audio clip duration ignores speed", () => {
    expect(audioClipDuration({ id: "a", timelineStart: 0, trimStart: 1, trimEnd: 6, volume: 1 })).toBeCloseTo(5);
  });

  it("timeline duration is the latest end across tracks", () => {
    const t = videoTimeline([
      clip({ id: "a", timelineStart: 0, trimStart: 0, trimEnd: 4 }),
      clip({ id: "b", timelineStart: 10, trimStart: 0, trimEnd: 3 }),
    ]);
    expect(timelineDurationV2(t)).toBeCloseTo(13);
  });
});

describe("migrateTimeline", () => {
  it("returns v2 docs unchanged", () => {
    const t = createEmptyTimelineV2();
    expect(migrateTimeline(t)).toBe(t);
  });

  it("positions sequential v1 clips with xfade overlap", () => {
    const v1: VideoTimeline = {
      width: 1280,
      height: 720,
      fps: 30,
      clips: [
        { id: "c1", videoId: 1, trimStart: 0, trimEnd: 5, transitionToNext: { type: "fade", duration: 1 } },
        { id: "c2", videoId: 2, trimStart: 0, trimEnd: 5 },
      ],
      overlays: [{ id: "o1", pngBase64: "x", start: 1, end: 3 }],
      audioTracks: [
        { id: "a1", filePath: "/m.mp3", start: 0, trimStart: 0, trimEnd: 8, volume: 0.5 },
      ],
    };
    const v2 = migrateTimeline(v1);
    const vt = videoTrack(v2);
    expect(vt.clips[0].timelineStart).toBeCloseTo(0);
    // second clip overlaps by the 1s transition: starts at 5 - 1 = 4
    expect(vt.clips[1].timelineStart).toBeCloseTo(4);
    const at = v2.tracks.find((x): x is AudioTrackV2 => x.kind === "audio")!;
    expect(at.clips[0].timelineStart).toBeCloseTo(0);
    const ot = v2.tracks.find((x) => x.kind === "overlay")!;
    expect(ot.kind === "overlay" && ot.items.length).toBe(1);
  });

  it("throws on unrecognized shapes", () => {
    expect(() => migrateTimeline({ foo: "bar" })).toThrow(/Unrecognized/);
  });
});

describe("splitClipAt", () => {
  it("splits a clip into two at the timeline position (speed-aware)", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 0, trimStart: 0, trimEnd: 10 })]);
    const out = splitClipAt(t, "vt", 4);
    const clips = videoTrack(out).clips;
    expect(clips).toHaveLength(2);
    expect(clips[0].trimEnd).toBeCloseTo(4);
    expect(clips[1].timelineStart).toBeCloseTo(4);
    expect(clips[1].trimStart).toBeCloseTo(4);
    // original untouched (immutability)
    expect(videoTrack(t).clips).toHaveLength(1);
  });

  it("converts timeline offset to source time at 2x speed", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 0, trimStart: 0, trimEnd: 10, speed: 2 })]);
    // played duration = 5; split at timeline 2 => source 4
    const clips = videoTrack(splitClipAt(t, "vt", 2)).clips;
    expect(clips[0].trimEnd).toBeCloseTo(4);
    expect(clips[1].trimStart).toBeCloseTo(4);
  });

  it("is a no-op when the time is outside any clip", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 0, trimEnd: 5 })]);
    expect(videoTrack(splitClipAt(t, "vt", 99)).clips).toHaveLength(1);
  });
});

describe("rippleDeleteClip", () => {
  it("removes a clip and shifts later clips left by its duration", () => {
    const t = videoTimeline([
      clip({ id: "a", timelineStart: 0, trimStart: 0, trimEnd: 4 }),
      clip({ id: "b", timelineStart: 4, trimStart: 0, trimEnd: 4 }),
      clip({ id: "c", timelineStart: 8, trimStart: 0, trimEnd: 4 }),
    ]);
    const clips = videoTrack(rippleDeleteClip(t, "vt", "b")).clips;
    expect(clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(clips[1].timelineStart).toBeCloseTo(4);
  });

  it("throws for an unknown clip", () => {
    const t = videoTimeline([clip({ id: "a" })]);
    expect(() => rippleDeleteClip(t, "vt", "nope")).toThrow(/Clip not found/);
  });
});

describe("deleteClip", () => {
  it("removes the clip leaving a gap", () => {
    const t = videoTimeline([
      clip({ id: "a", timelineStart: 0, trimEnd: 4 }),
      clip({ id: "b", timelineStart: 4, trimEnd: 4 }),
    ]);
    const clips = videoTrack(deleteClip(t, "vt", "a")).clips;
    expect(clips.map((c) => c.id)).toEqual(["b"]);
    expect(clips[0].timelineStart).toBeCloseTo(4);
  });
});

describe("moveClip", () => {
  it("repositions a clip and re-sorts by start", () => {
    const t = videoTimeline([
      clip({ id: "a", timelineStart: 0, trimEnd: 4 }),
      clip({ id: "b", timelineStart: 4, trimEnd: 4 }),
    ]);
    const clips = videoTrack(moveClip(t, "vt", "a", 10)).clips;
    expect(clips.map((c) => c.id)).toEqual(["b", "a"]);
    expect(clips[1].timelineStart).toBeCloseTo(10);
  });

  it("clamps negative start to zero", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 5, trimEnd: 4 })]);
    expect(videoTrack(moveClip(t, "vt", "a", -3)).clips[0].timelineStart).toBe(0);
  });

  it("rejects moving onto a track of a different kind", () => {
    const t: VideoTimelineV2 = {
      ...videoTimeline([clip({ id: "a", trimEnd: 4 })]),
      tracks: [
        { id: "vt", kind: "video", clips: [clip({ id: "a", trimEnd: 4 })] },
        { id: "at", kind: "audio", clips: [] },
      ],
    };
    expect(() => moveClip(t, "vt", "a", 0, "at")).toThrow(/Cannot move/);
  });
});

describe("trimClip", () => {
  it("trims the start edge, moving both timelineStart and trimStart", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 0, trimStart: 0, trimEnd: 10 })]);
    const c = videoTrack(trimClip(t, "vt", "a", "start", 3)).clips[0];
    expect(c.timelineStart).toBeCloseTo(3);
    expect(c.trimStart).toBeCloseTo(3);
  });

  it("trims the end edge, adjusting trimEnd only", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 0, trimStart: 0, trimEnd: 10 })]);
    const c = videoTrack(trimClip(t, "vt", "a", "end", 6)).clips[0];
    expect(c.timelineStart).toBeCloseTo(0);
    expect(c.trimEnd).toBeCloseTo(6);
  });

  it("clamps the start edge so the clip keeps a minimum duration", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 0, trimStart: 0, trimEnd: 10 })]);
    const c = videoTrack(trimClip(t, "vt", "a", "start", 999)).clips[0];
    expect(c.timelineStart).toBeLessThan(10);
    expect(videoClipDuration(c)).toBeGreaterThan(0);
  });
});

describe("snapping", () => {
  it("collects clip edges, markers, and zero as candidates", () => {
    const t: VideoTimelineV2 = {
      ...videoTimeline([clip({ id: "a", timelineStart: 2, trimStart: 0, trimEnd: 3 })]),
      markers: [{ id: "m", time: 7 }],
    };
    const cands = snapCandidates(t);
    expect(cands).toContain(0);
    expect(cands).toContain(2);
    expect(cands).toContain(5); // 2 + 3
    expect(cands).toContain(7);
  });

  it("excludes the dragged clip's own edges", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 2, trimEnd: 3 })]);
    expect(snapCandidates(t, "a")).not.toContain(2);
  });

  it("snaps to the nearest candidate within the threshold", () => {
    expect(resolveSnap(2.04, [0, 2, 5], 0.1)).toEqual({ time: 2, snappedTo: 2 });
    expect(resolveSnap(3.5, [0, 2, 5], 0.1)).toEqual({ time: 3.5, snappedTo: null });
  });
});

describe("addTrack", () => {
  it("appends a new empty track of the requested kind", () => {
    const t = addTrack(createEmptyTimelineV2(), "audio", "Music");
    const last = t.tracks[t.tracks.length - 1];
    expect(last.kind).toBe("audio");
    expect(last.name).toBe("Music");
  });
});

describe("toLegacyTimeline", () => {
  it("round-trips a single-track v2 doc back to a v1 render doc", () => {
    const v2 = videoTimeline([
      clip({ id: "a", videoId: 1, timelineStart: 0, trimStart: 0, trimEnd: 4 }),
      clip({ id: "b", videoId: 2, timelineStart: 4, trimStart: 0, trimEnd: 4 }),
    ]);
    const v1 = toLegacyTimeline(v2);
    expect(v1.clips.map((c) => c.id)).toEqual(["a", "b"]);
    expect(v1.clips[0].videoId).toBe(1);
    expect(v1.width).toBe(1280);
  });

  it("sorts clips by timeline position before flattening", () => {
    const v2 = videoTimeline([
      clip({ id: "b", videoId: 2, timelineStart: 4, trimEnd: 4 }),
      clip({ id: "a", videoId: 1, timelineStart: 0, trimEnd: 4 }),
    ]);
    expect(toLegacyTimeline(v2).clips.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("merges audio tracks into v1 audioTracks", () => {
    const v2: VideoTimelineV2 = {
      version: 2,
      width: 1280,
      height: 720,
      fps: 30,
      tracks: [
        { id: "vt", kind: "video", clips: [clip({ id: "a", trimEnd: 4 })] },
        {
          id: "at",
          kind: "audio",
          clips: [{ id: "m", filePath: "/x.mp3", timelineStart: 0, trimStart: 0, trimEnd: 4, volume: 1 }],
        },
      ],
    };
    expect(toLegacyTimeline(v2).audioTracks).toHaveLength(1);
  });
});

describe("immutability", () => {
  it("edit ops never mutate the input timeline", () => {
    const t = videoTimeline([clip({ id: "a", timelineStart: 0, trimEnd: 10 })]);
    const snapshot = JSON.stringify(t);
    splitClipAt(t, "vt", 5);
    moveClip(t, "vt", "a", 3);
    trimClip(t, "vt", "a", "end", 4);
    deleteClip(t, "vt", "a");
    expect(JSON.stringify(t)).toBe(snapshot);
    expect(Math.abs(timelineDurationV2(t) - 10)).toBeLessThan(EPS);
  });
});
