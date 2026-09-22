import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Text as KonvaText,
  Rect,
  Transformer,
} from "react-konva";
import Konva from "konva";
import { IpcClient } from "@/ipc/ipc_client";
import type { VideoStudioVideo, ImageStudioImage } from "@/ipc/ipc_types";
import type { VideoTimeline, TransitionType } from "@/lib/video/timeline_types";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { VoiceAssistantClient } from "@/ipc/voice_assistant_client";
import {
  TrackLane,
  TimelineRuler,
  TimelinePlayhead,
  TimelineClipBlock,
} from "@/components/video-studio/editor/TrackLane";
import {
  X,
  Play,
  Pause,
  Scissors,
  Type as TypeIcon,
  ImagePlus,
  Music,
  Film,
  Plus,
  Trash2,
  ArrowLeft,
  ArrowRight,
  Download,
  Save,
  Loader2,
  ZoomIn,
  ZoomOut,
  SkipBack,
  Layers,
  Settings2,
  Mic,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface EditorClip {
  id: string;
  videoId: number;
  trimStart: number;
  trimEnd: number;
  speed: number;
  volume: number;
  transition?: { type: TransitionType; duration: number };
  /** Accurate source duration in seconds (probed). */
  srcDuration: number;
  name: string;
}

type OverlayKind = "text" | "image";

interface EditorOverlay {
  id: string;
  kind: OverlayKind;
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  // text
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fill?: string;
  align?: "left" | "center" | "right";
  fontStyle?: string;
  backgroundColor?: string;
  // image
  imageId?: number;
}

interface EditorAudio {
  id: string;
  /** DB id of a source video whose audio is extracted (undefined for voiceover). */
  videoId?: number;
  /** Absolute path to a standalone audio file (e.g. generated voiceover). */
  filePath?: string;
  kind?: "video" | "voiceover";
  start: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
  label: string;
}

interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

const RESOLUTIONS: ResolutionPreset[] = [
  { label: "16:9 — 1920×1080", width: 1920, height: 1080 },
  { label: "16:9 — 1280×720", width: 1280, height: 720 },
  { label: "9:16 — 1080×1920", width: 1080, height: 1920 },
  { label: "1:1 — 1080×1080", width: 1080, height: 1080 },
  { label: "4:5 — 1080×1350", width: 1080, height: 1350 },
];

const FONT_FAMILIES = [
  "Arial",
  "Helvetica",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Impact",
  "Comic Sans MS",
];

const TRANSITIONS: { value: TransitionType | "none"; label: string }[] = [
  { value: "none", label: "None (cut)" },
  { value: "fade", label: "Crossfade" },
  { value: "fadeblack", label: "Fade through black" },
  { value: "fadewhite", label: "Fade through white" },
  { value: "dissolve", label: "Dissolve" },
  { value: "wipeleft", label: "Wipe left" },
  { value: "wiperight", label: "Wipe right" },
  { value: "slideleft", label: "Slide left" },
  { value: "slideright", label: "Slide right" },
  { value: "circleopen", label: "Circle open" },
];

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

function clipPlayedDuration(clip: EditorClip): number {
  return Math.max(0.05, (clip.trimEnd - clip.trimStart) / (clip.speed > 0 ? clip.speed : 1));
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${m}:${sec.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(",");
  const mime = head.match(/data:(.*?);/)?.[1] ?? "application/octet-stream";
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ── Component ──────────────────────────────────────────────────────────────────

export function VideoEditor({
  videoId,
  projectId,
  onClose,
}: {
  videoId?: number;
  projectId?: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const [projectName, setProjectName] = useState("Untitled Project");
  const [currentProjectId, setCurrentProjectId] = useState<number | undefined>(projectId);
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [fps, setFps] = useState(30);
  const [backgroundColor, setBackgroundColor] = useState("#000000");
  const [muteClipAudio, setMuteClipAudio] = useState(false);

  const [clips, setClips] = useState<EditorClip[]>([]);
  const [overlays, setOverlays] = useState<EditorOverlay[]>([]);
  const [audioTracks, setAudioTracks] = useState<EditorAudio[]>([]);

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null);

  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pps, setPps] = useState(60); // timeline pixels per second
  const [previewScale, setPreviewScale] = useState(0.5);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState<{ fraction: number; stage: string } | null>(null);
  const [initialized, setInitialized] = useState(false);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const previewWrapRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number>(0);
  const objectUrlCache = useRef<Map<number, string>>(new Map());
  const imageElCache = useRef<Map<number, HTMLImageElement>>(new Map());
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const overlayNodeRefs = useRef<Map<string, Konva.Node>>(new Map());

  const [imageEls, setImageEls] = useState<Map<number, HTMLImageElement>>(new Map());

  // ── Source pickers data ──────────────────────────────────────────────────
  const { data: galleryVideos = [] } = useQuery<VideoStudioVideo[]>({
    queryKey: ["video-studio", "list", "editor-picker"],
    queryFn: () => IpcClient.getInstance().listVideos({ limit: 200 }),
    staleTime: 30_000,
  });

  const { data: galleryImages = [] } = useQuery<ImageStudioImage[]>({
    queryKey: ["image-studio", "list", "editor-picker"],
    queryFn: () => IpcClient.getInstance().listImages({ limit: 200 }),
    staleTime: 30_000,
  });

  // ── Derived ────────────────────────────────────────────────────────────────
  const totalDuration = useMemo(
    () => clips.reduce((sum, c) => sum + clipPlayedDuration(c), 0),
    [clips],
  );

  const clipStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const c of clips) {
      starts.push(acc);
      acc += clipPlayedDuration(c);
    }
    return starts;
  }, [clips]);

  const activeClipIndex = useMemo(() => {
    if (!clips.length) return -1;
    for (let i = clips.length - 1; i >= 0; i--) {
      if (playhead >= clipStarts[i] - 1e-6) return i;
    }
    return 0;
  }, [clips, clipStarts, playhead]);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;
  const selectedOverlay = overlays.find((o) => o.id === selectedOverlayId) ?? null;
  const selectedAudio = audioTracks.find((a) => a.id === selectedAudioId) ?? null;

  // ── Helpers: object URLs & images ────────────────────────────────────────
  const getVideoObjectUrl = useCallback(async (vid: number): Promise<string> => {
    const cache = objectUrlCache.current;
    const existing = cache.get(vid);
    if (existing) return existing;
    const dataUrl = await IpcClient.getInstance().readVideo(vid);
    const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
    cache.set(vid, url);
    return url;
  }, []);

  const loadImageEl = useCallback(async (imageId: number): Promise<HTMLImageElement> => {
    const cache = imageElCache.current;
    const existing = cache.get(imageId);
    if (existing) return existing;
    const dataUrl = await IpcClient.getInstance().readImageAsBase64(imageId);
    const img = new window.Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = dataUrl;
    });
    cache.set(imageId, img);
    setImageEls((prev) => new Map(prev).set(imageId, img));
    return img;
  }, []);

  // ── Initial load (from source video or project) ──────────────────────────
  useEffect(() => {
    if (initialized) return;
    let cancelled = false;
    (async () => {
      try {
        if (projectId != null) {
          const proj = await IpcClient.getInstance().getVideoProject(projectId);
          if (cancelled) return;
          setProjectName(proj.name);
          setCurrentProjectId(proj.id);
          const t = (proj.timelineJson ?? {}) as Record<string, unknown>;
          if (typeof t.width === "number") setWidth(t.width);
          if (typeof t.height === "number") setHeight(t.height);
          if (typeof t.fps === "number") setFps(t.fps);
          if (typeof t.backgroundColor === "string") setBackgroundColor(t.backgroundColor);
          if (typeof t.muteClipAudio === "boolean") setMuteClipAudio(t.muteClipAudio);
          if (Array.isArray(t.clips)) setClips(t.clips as unknown as EditorClip[]);
          if (Array.isArray(t.editorOverlays)) setOverlays(t.editorOverlays as unknown as EditorOverlay[]);
          if (Array.isArray(t.audioTracks)) setAudioTracks(t.audioTracks as unknown as EditorAudio[]);
          // Preload images for image overlays
          for (const ov of (t.editorOverlays as EditorOverlay[]) ?? []) {
            if (ov.kind === "image" && ov.imageId != null) loadImageEl(ov.imageId).catch(() => {});
          }
        } else if (videoId != null) {
          const probe = await IpcClient.getInstance().probeVideo(videoId).catch(() => null);
          const dur = probe?.duration ?? 5;
          if (probe?.width) setWidth(probe.width);
          if (probe?.height) setHeight(probe.height);
          if (probe?.fps) setFps(Math.round(probe.fps));
          const vid = galleryVideos.find((v) => v.id === videoId);
          if (cancelled) return;
          setClips([
            {
              id: nextId("clip"),
              videoId,
              trimStart: 0,
              trimEnd: dur,
              speed: 1,
              volume: 1,
              srcDuration: dur,
              name: vid?.prompt?.slice(0, 40) ?? `Clip ${videoId}`,
            },
          ]);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load editor");
      } finally {
        if (!cancelled) setInitialized(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, videoId, galleryVideos]);

  // ── Fit preview scale ────────────────────────────────────────────────────
  useEffect(() => {
    const fit = () => {
      const wrap = previewWrapRef.current;
      if (!wrap) return;
      const maxW = wrap.clientWidth - 16;
      const maxH = wrap.clientHeight - 16;
      if (maxW <= 0 || maxH <= 0) return;
      setPreviewScale(Math.min(maxW / width, maxH / height, 1));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [width, height]);

  // ── Drive the preview <video> to the active clip + playhead ──────────────
  useEffect(() => {
    const el = videoElRef.current;
    if (!el || activeClipIndex < 0) return;
    const clip = clips[activeClipIndex];
    if (!clip) return;
    let cancelled = false;
    (async () => {
      const url = await getVideoObjectUrl(clip.videoId);
      if (cancelled || !videoElRef.current) return;
      const v = videoElRef.current;
      if (v.dataset.vid !== String(clip.videoId)) {
        v.src = url;
        v.dataset.vid = String(clip.videoId);
        await v.play().then(() => v.pause()).catch(() => {});
      }
      const localStart = clipStarts[activeClipIndex];
      const into = (playhead - localStart) * clip.speed + clip.trimStart;
      if (!isPlaying && Math.abs(v.currentTime - into) > 0.15) {
        v.currentTime = Math.min(clip.srcDuration, Math.max(0, into));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClipIndex, playhead, clips, isPlaying]);

  // ── Playback loop ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      videoElRef.current?.pause();
      return;
    }
    videoElRef.current?.play().catch(() => {});
    lastTsRef.current = performance.now();
    const tick = (ts: number) => {
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      setPlayhead((p) => {
        const next = p + dt;
        if (next >= totalDuration) {
          setIsPlaying(false);
          return totalDuration;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, totalDuration]);

  // ── Transformer attach ───────────────────────────────────────────────────
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    if (selectedOverlayId) {
      const node = overlayNodeRefs.current.get(selectedOverlayId);
      if (node) {
        tr.nodes([node]);
        tr.getLayer()?.batchDraw();
        return;
      }
    }
    tr.nodes([]);
    tr.getLayer()?.batchDraw();
  }, [selectedOverlayId, overlays, playhead]);

  // ── Render progress subscription ─────────────────────────────────────────
  useEffect(() => {
    const off = IpcClient.getInstance().onVideoRenderProgress((evt) => {
      setRenderProgress(evt);
    });
    return off;
  }, []);

  // ── Cleanup object URLs on unmount ───────────────────────────────────────
  useEffect(() => {
    const cache = objectUrlCache.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    };
  }, []);

  // ── Clip operations ────────────────────────────────────────────────────────
  const addClip = useCallback(
    async (vid: number) => {
      const probe = await IpcClient.getInstance().probeVideo(vid).catch(() => null);
      const dur = probe?.duration ?? 5;
      const v = galleryVideos.find((g) => g.id === vid);
      setClips((prev) => [
        ...prev,
        {
          id: nextId("clip"),
          videoId: vid,
          trimStart: 0,
          trimEnd: dur,
          speed: 1,
          volume: 1,
          srcDuration: dur,
          name: v?.prompt?.slice(0, 40) ?? `Clip ${vid}`,
        },
      ]);
      toast.success("Clip added");
    },
    [galleryVideos],
  );

  const updateClip = useCallback((id: string, patch: Partial<EditorClip>) => {
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
    setSelectedClipId((cur) => (cur === id ? null : cur));
  }, []);

  const moveClip = useCallback((id: string, dir: -1 | 1) => {
    setClips((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  }, []);

  const splitClipAtPlayhead = useCallback(() => {
    if (activeClipIndex < 0) return;
    const clip = clips[activeClipIndex];
    const localStart = clipStarts[activeClipIndex];
    const into = (playhead - localStart) * clip.speed + clip.trimStart;
    if (into <= clip.trimStart + 0.05 || into >= clip.trimEnd - 0.05) {
      toast.error("Move the playhead inside the clip to split");
      return;
    }
    const first: EditorClip = { ...clip, trimEnd: into };
    const second: EditorClip = { ...clip, id: nextId("clip"), trimStart: into, transition: undefined };
    setClips((prev) => {
      const copy = [...prev];
      copy.splice(activeClipIndex, 1, first, second);
      return copy;
    });
    toast.success("Clip split");
  }, [activeClipIndex, clips, clipStarts, playhead]);

  // ── Overlay operations ─────────────────────────────────────────────────────
  const addTextOverlay = useCallback(() => {
    const ov: EditorOverlay = {
      id: nextId("ov"),
      kind: "text",
      start: Math.floor(playhead),
      end: Math.min(totalDuration || playhead + 3, Math.floor(playhead) + 3),
      fadeIn: 0.3,
      fadeOut: 0.3,
      x: Math.round(width * 0.1),
      y: Math.round(height * 0.4),
      width: Math.round(width * 0.8),
      height: Math.round(height * 0.2),
      rotation: 0,
      text: "Your text here",
      fontSize: Math.round(height * 0.08),
      fontFamily: "Arial",
      fill: "#ffffff",
      align: "center",
      fontStyle: "bold",
      backgroundColor: "",
    };
    setOverlays((prev) => [...prev, ov]);
    setSelectedOverlayId(ov.id);
    setSelectedClipId(null);
  }, [playhead, totalDuration, width, height]);

  const addImageOverlay = useCallback(
    async (imageId: number) => {
      const img = await loadImageEl(imageId).catch(() => null);
      const ar = img ? img.width / img.height : 16 / 9;
      const w = Math.round(width * 0.4);
      const ov: EditorOverlay = {
        id: nextId("ov"),
        kind: "image",
        start: Math.floor(playhead),
        end: Math.min(totalDuration || playhead + 3, Math.floor(playhead) + 3),
        fadeIn: 0.3,
        fadeOut: 0.3,
        x: Math.round(width * 0.3),
        y: Math.round(height * 0.3),
        width: w,
        height: Math.round(w / ar),
        rotation: 0,
        imageId,
      };
      setOverlays((prev) => [...prev, ov]);
      setSelectedOverlayId(ov.id);
      setSelectedClipId(null);
    },
    [playhead, totalDuration, width, height, loadImageEl],
  );

  const updateOverlay = useCallback((id: string, patch: Partial<EditorOverlay>) => {
    setOverlays((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }, []);

  const removeOverlay = useCallback((id: string) => {
    setOverlays((prev) => prev.filter((o) => o.id !== id));
    setSelectedOverlayId((cur) => (cur === id ? null : cur));
  }, []);

  // ── Audio operations ───────────────────────────────────────────────────────
  const addAudioTrack = useCallback(
    async (vid: number) => {
      const probe = await IpcClient.getInstance().probeVideo(vid).catch(() => null);
      const dur = probe?.duration ?? 5;
      const v = galleryVideos.find((g) => g.id === vid);
      const track: EditorAudio = {
        id: nextId("aud"),
        videoId: vid,
        kind: "video",
        start: 0,
        trimStart: 0,
        trimEnd: dur,
        volume: 1,
        label: v?.prompt?.slice(0, 30) ?? `Audio ${vid}`,
      };
      setAudioTracks((prev) => [...prev, track]);
      setSelectedAudioId(track.id);
      toast.success("Audio track added");
    },
    [galleryVideos],
  );

  const addVoiceoverTrack = useCallback(
    (filePath: string, duration: number, label: string) => {
      const track: EditorAudio = {
        id: nextId("aud"),
        filePath,
        kind: "voiceover",
        start: playhead,
        trimStart: 0,
        trimEnd: duration,
        volume: 1,
        label,
      };
      setAudioTracks((prev) => [...prev, track]);
      setSelectedAudioId(track.id);
    },
    [playhead],
  );

  const updateAudio = useCallback((id: string, patch: Partial<EditorAudio>) => {
    setAudioTracks((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const removeAudio = useCallback((id: string) => {
    setAudioTracks((prev) => prev.filter((a) => a.id !== id));
    setSelectedAudioId((cur) => (cur === id ? null : cur));
  }, []);

  // ── Build timeline JSON for persistence ──────────────────────────────────
  const buildProjectTimelineJson = useCallback((): Record<string, unknown> => {
    return {
      width,
      height,
      fps,
      backgroundColor,
      muteClipAudio,
      clips,
      editorOverlays: overlays,
      audioTracks,
    };
  }, [width, height, fps, backgroundColor, muteClipAudio, clips, overlays, audioTracks]);

  // ── Save project ───────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      const timeline = buildProjectTimelineJson() as unknown as VideoTimeline;
      if (currentProjectId != null) {
        return IpcClient.getInstance().updateVideoProject({
          id: currentProjectId,
          name: projectName,
          timeline,
        });
      }
      return IpcClient.getInstance().createVideoProject({ name: projectName, timeline });
    },
    onSuccess: (proj) => {
      setCurrentProjectId(proj.id);
      queryClient.invalidateQueries({ queryKey: ["video-projects", "list"] });
      toast.success("Project saved");
    },
    onError: (err: Error) => toast.error(`Save failed: ${err.message}`),
  });

  // ── Rasterize overlays for export ────────────────────────────────────────
  const rasterizeOverlay = useCallback(
    async (ov: EditorOverlay): Promise<string | null> => {
      const container = document.createElement("div");
      const stage = new Konva.Stage({ container, width, height });
      const layer = new Konva.Layer();
      stage.add(layer);
      try {
        if (ov.kind === "text") {
          if (ov.backgroundColor) {
            layer.add(
              new Konva.Rect({
                x: ov.x,
                y: ov.y,
                width: ov.width,
                height: ov.height,
                fill: ov.backgroundColor,
                rotation: ov.rotation,
              }),
            );
          }
          layer.add(
            new Konva.Text({
              x: ov.x,
              y: ov.y,
              width: ov.width,
              text: ov.text ?? "",
              fontSize: ov.fontSize ?? 48,
              fontFamily: ov.fontFamily ?? "Arial",
              fontStyle: ov.fontStyle ?? "normal",
              fill: ov.fill ?? "#ffffff",
              align: ov.align ?? "center",
              rotation: ov.rotation,
              shadowColor: "#000000",
              shadowBlur: 4,
              shadowOpacity: 0.5,
            }),
          );
        } else if (ov.kind === "image" && ov.imageId != null) {
          const img = await loadImageEl(ov.imageId);
          layer.add(
            new Konva.Image({
              image: img,
              x: ov.x,
              y: ov.y,
              width: ov.width,
              height: ov.height,
              rotation: ov.rotation,
            }),
          );
        }
        layer.draw();
        const dataUrl = stage.toDataURL({ pixelRatio: 1 });
        return dataUrl.replace(/^data:image\/\w+;base64,/, "");
      } finally {
        stage.destroy();
      }
    },
    [width, height, loadImageEl],
  );

  // ── Render / export ──────────────────────────────────────────────────────
  const handleRender = useCallback(async () => {
    if (!clips.length) {
      toast.error("Add at least one clip before rendering");
      return;
    }
    setRendering(true);
    setRenderProgress({ fraction: 0, stage: "Starting" });
    try {
      const renderedOverlays = [];
      for (const ov of overlays) {
        const png = await rasterizeOverlay(ov);
        if (png) {
          renderedOverlays.push({
            id: ov.id,
            pngBase64: png,
            start: ov.start,
            end: ov.end,
            fadeIn: ov.fadeIn,
            fadeOut: ov.fadeOut,
            label: ov.kind === "text" ? ov.text?.slice(0, 20) : "image",
          });
        }
      }

      const timeline: VideoTimeline = {
        width,
        height,
        fps,
        backgroundColor,
        muteClipAudio,
        clips: clips.map((c) => ({
          id: c.id,
          videoId: c.videoId,
          trimStart: c.trimStart,
          trimEnd: c.trimEnd,
          speed: c.speed,
          volume: c.volume,
          transitionToNext: c.transition,
        })),
        overlays: renderedOverlays,
        audioTracks: audioTracks.map((a) => ({
          id: a.id,
          videoId: a.videoId,
          filePath: a.filePath,
          start: a.start,
          trimStart: a.trimStart,
          trimEnd: a.trimEnd,
          volume: a.volume,
          label: a.label,
        })),
      };

      const result = await IpcClient.getInstance().renderTimeline({
        timeline,
        projectId: currentProjectId,
        projectName,
      });
      queryClient.invalidateQueries({ queryKey: ["video-studio", "list"] });
      toast.success(`Rendered "${result.prompt}" — added to gallery`);
    } catch (err) {
      toast.error(`Render failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setRendering(false);
      setRenderProgress(null);
    }
  }, [
    clips,
    overlays,
    audioTracks,
    width,
    height,
    fps,
    backgroundColor,
    muteClipAudio,
    currentProjectId,
    projectName,
    rasterizeOverlay,
    queryClient,
  ]);

  // ── Visible overlays at playhead (always show selected) ──────────────────
  const visibleOverlays = overlays.filter(
    (o) => o.id === selectedOverlayId || (playhead >= o.start && playhead <= o.end),
  );

  // ── Render ───────────────────────────────────────────────────────────────
  const timelineWidthPx = Math.max(600, totalDuration * pps + 40);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-background/95">
        <Film className="w-5 h-5 text-violet-500" />
        <Input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          className="h-8 w-56 text-sm font-medium"
        />
        <div className="flex-1" />
        {rendering && renderProgress && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{renderProgress.stage}</span>
            <div className="w-32 h-1.5 rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all"
                style={{ width: `${Math.round((renderProgress.fraction || 0) * 100)}%` }}
              />
            </div>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-1" />
          )}
          Save
        </Button>
        <Button
          size="sm"
          onClick={handleRender}
          disabled={rendering || !clips.length}
          className="bg-violet-600 hover:bg-violet-700"
        >
          {rendering ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Download className="w-4 h-4 mr-1" />
          )}
          Render & Export
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="w-5 h-5" />
        </Button>
      </div>

      {/* Main area: preview + properties */}
      <div className="flex flex-1 overflow-hidden">
        {/* Preview */}
        <div className="flex flex-col flex-1 overflow-hidden bg-neutral-950">
          <div ref={previewWrapRef} className="flex-1 flex items-center justify-center overflow-hidden p-2">
            <div
              className="relative shadow-2xl"
              style={{ width: width * previewScale, height: height * previewScale, backgroundColor }}
            >
              <video
                ref={videoElRef}
                className="absolute inset-0 w-full h-full object-contain"
                muted={muteClipAudio}
                playsInline
              />
              <div className="absolute inset-0">
                <Stage
                  width={width * previewScale}
                  height={height * previewScale}
                  scaleX={previewScale}
                  scaleY={previewScale}
                  onMouseDown={(e) => {
                    if (e.target === e.target.getStage()) setSelectedOverlayId(null);
                  }}
                >
                  <Layer>
                    {visibleOverlays.map((ov) =>
                      ov.kind === "text" ? (
                        <OverlayTextNode
                          key={ov.id}
                          overlay={ov}
                          onSelect={() => {
                            setSelectedOverlayId(ov.id);
                            setSelectedClipId(null);
                          }}
                          onChange={(patch) => updateOverlay(ov.id, patch)}
                          registerNode={(n) => {
                            if (n) overlayNodeRefs.current.set(ov.id, n);
                            else overlayNodeRefs.current.delete(ov.id);
                          }}
                        />
                      ) : (
                        <OverlayImageNode
                          key={ov.id}
                          overlay={ov}
                          image={imageEls.get(ov.imageId ?? -1) ?? null}
                          onSelect={() => {
                            setSelectedOverlayId(ov.id);
                            setSelectedClipId(null);
                          }}
                          onChange={(patch) => updateOverlay(ov.id, patch)}
                          registerNode={(n) => {
                            if (n) overlayNodeRefs.current.set(ov.id, n);
                            else overlayNodeRefs.current.delete(ov.id);
                          }}
                        />
                      ),
                    )}
                    <Transformer
                      ref={transformerRef}
                      rotateEnabled
                      boundBoxFunc={(oldBox, newBox) =>
                        newBox.width < 10 || newBox.height < 10 ? oldBox : newBox
                      }
                    />
                  </Layer>
                </Stage>
              </div>
            </div>
          </div>

          {/* Transport controls */}
          <div className="flex items-center gap-2 px-4 py-2 border-t bg-background/95">
            <Button variant="ghost" size="icon" onClick={() => setPlayhead(0)}>
              <SkipBack className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsPlaying((p) => !p)}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </Button>
            <span className="text-xs font-mono text-muted-foreground tabular-nums">
              {fmtTime(playhead)} / {fmtTime(totalDuration)}
            </span>
            <div className="flex-1" />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={splitClipAtPlayhead}>
                    <Scissors className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Split clip at playhead</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <Button variant="ghost" size="icon" onClick={() => setPps((z) => Math.max(20, z - 15))}>
              <ZoomOut className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setPps((z) => Math.min(200, z + 15))}>
              <ZoomIn className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Right properties panel */}
        <div className="w-80 border-l flex flex-col overflow-hidden">
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-4">
              {selectedClip ? (
                <ClipProperties
                  clip={selectedClip}
                  onChange={(patch) => updateClip(selectedClip.id, patch)}
                  isLast={clips[clips.length - 1]?.id === selectedClip.id}
                  isFirst={clips[0]?.id === selectedClip.id}
                  onDelete={() => removeClip(selectedClip.id)}
                  onMoveLeft={() => moveClip(selectedClip.id, -1)}
                  onMoveRight={() => moveClip(selectedClip.id, 1)}
                />
              ) : selectedOverlay ? (
                <OverlayProperties
                  overlay={selectedOverlay}
                  onChange={(patch) => updateOverlay(selectedOverlay.id, patch)}
                  maxDuration={totalDuration}
                  onDelete={() => removeOverlay(selectedOverlay.id)}
                />
              ) : selectedAudio ? (
                <AudioProperties
                  audio={selectedAudio}
                  onChange={(patch) => updateAudio(selectedAudio.id, patch)}
                  maxDuration={totalDuration}
                  onDelete={() => removeAudio(selectedAudio.id)}
                />
              ) : (
                <ProjectSettings
                  width={width}
                  height={height}
                  fps={fps}
                  backgroundColor={backgroundColor}
                  muteClipAudio={muteClipAudio}
                  onResolution={(w, h) => {
                    setWidth(w);
                    setHeight(h);
                  }}
                  onFps={setFps}
                  onBackground={setBackgroundColor}
                  onMuteClipAudio={setMuteClipAudio}
                />
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Timeline */}
      <div className="border-t bg-background/95 h-56 flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b">
          <AddClipMenu videos={galleryVideos} onAdd={addClip} />
          <Button variant="ghost" size="sm" onClick={addTextOverlay}>
            <TypeIcon className="w-3.5 h-3.5 mr-1" /> Text
          </Button>
          <AddImageMenu images={galleryImages} onAdd={addImageOverlay} />
          <AddAudioMenu videos={galleryVideos} onAdd={addAudioTrack} />
          <VoiceoverButton onGenerated={addVoiceoverTrack} />
          <div className="flex-1" />
          <span className="text-[10px] text-muted-foreground">
            {clips.length} clips · {overlays.length} overlays · {audioTracks.length} audio
          </span>
        </div>

        <ScrollArea className="flex-1">
          <div style={{ width: timelineWidthPx }} className="relative select-none">
            {/* Ruler / click to seek */}
            <TimelineRuler duration={totalDuration} pps={pps} onSeek={setPlayhead} />

            {/* Playhead */}
            <TimelinePlayhead time={playhead} pps={pps} />

            {/* Video track */}
            <TrackLane icon={<Film className="w-3 h-3" />} label="Video">
              {clips.map((clip, i) => (
                <TimelineClipBlock
                  key={clip.id}
                  start={clipStarts[i]}
                  duration={clipPlayedDuration(clip)}
                  pps={pps}
                  selected={selectedClipId === clip.id}
                  toneClass="border-border bg-muted hover:border-violet-400"
                  transitionBadge={!!clip.transition && i < clips.length - 1}
                  onSelect={() => {
                    setSelectedClipId(clip.id);
                    setSelectedOverlayId(null);
                    setSelectedAudioId(null);
                  }}
                >
                  <span className="truncate">{clip.name}</span>
                </TimelineClipBlock>
              ))}
            </TrackLane>

            {/* Overlay track */}
            <TrackLane icon={<Layers className="w-3 h-3" />} label="Overlays">
              {overlays.map((ov) => (
                <TimelineClipBlock
                  key={ov.id}
                  start={ov.start}
                  duration={ov.end - ov.start}
                  pps={pps}
                  selected={selectedOverlayId === ov.id}
                  toneClass="border-border bg-sky-500/10 hover:border-sky-400"
                  onSelect={() => {
                    setSelectedOverlayId(ov.id);
                    setSelectedClipId(null);
                    setSelectedAudioId(null);
                  }}
                >
                  {ov.kind === "text" ? (
                    <TypeIcon className="w-2.5 h-2.5 mr-1 shrink-0" />
                  ) : (
                    <ImagePlus className="w-2.5 h-2.5 mr-1 shrink-0" />
                  )}
                  <span className="truncate">{ov.kind === "text" ? ov.text : "Image"}</span>
                </TimelineClipBlock>
              ))}
            </TrackLane>

            {/* Audio track */}
            <TrackLane icon={<Music className="w-3 h-3" />} label="Audio">
              {audioTracks.map((a) => (
                <TimelineClipBlock
                  key={a.id}
                  start={a.start}
                  duration={Math.max(0.1, a.trimEnd - a.trimStart)}
                  pps={pps}
                  selected={selectedAudioId === a.id}
                  toneClass="border-border bg-emerald-500/10 hover:border-emerald-400"
                  onSelect={() => {
                    setSelectedAudioId(a.id);
                    setSelectedClipId(null);
                    setSelectedOverlayId(null);
                  }}
                >
                  {a.kind === "voiceover" ? (
                    <Mic className="w-2.5 h-2.5 mr-1 shrink-0" />
                  ) : (
                    <Music className="w-2.5 h-2.5 mr-1 shrink-0" />
                  )}
                  <span className="truncate">{a.label}</span>
                </TimelineClipBlock>
              ))}
            </TrackLane>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// ── Konva overlay nodes ──────────────────────────────────────────────────────

function OverlayTextNode({
  overlay,
  onSelect,
  onChange,
  registerNode,
}: {
  overlay: EditorOverlay;
  onSelect: () => void;
  onChange: (patch: Partial<EditorOverlay>) => void;
  registerNode: (node: Konva.Node | null) => void;
}) {
  const ref = useRef<Konva.Text | null>(null);
  useEffect(() => {
    registerNode(ref.current);
    return () => registerNode(null);
  }, [registerNode]);
  return (
    <>
      {overlay.backgroundColor ? (
        <Rect
          x={overlay.x}
          y={overlay.y}
          width={overlay.width}
          height={overlay.height}
          fill={overlay.backgroundColor}
          rotation={overlay.rotation}
          listening={false}
        />
      ) : null}
      <KonvaText
        ref={ref}
        x={overlay.x}
        y={overlay.y}
        width={overlay.width}
        text={overlay.text ?? ""}
        fontSize={overlay.fontSize ?? 48}
        fontFamily={overlay.fontFamily ?? "Arial"}
        fontStyle={overlay.fontStyle ?? "normal"}
        fill={overlay.fill ?? "#ffffff"}
        align={overlay.align ?? "center"}
        rotation={overlay.rotation}
        shadowColor="#000000"
        shadowBlur={4}
        shadowOpacity={0.5}
        draggable
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
        onTransformEnd={(e) => {
          const node = e.target as Konva.Text;
          const scaleX = node.scaleX();
          node.scaleX(1);
          node.scaleY(1);
          onChange({
            x: node.x(),
            y: node.y(),
            width: Math.max(20, node.width() * scaleX),
            rotation: node.rotation(),
          });
        }}
      />
    </>
  );
}

function OverlayImageNode({
  overlay,
  image,
  onSelect,
  onChange,
  registerNode,
}: {
  overlay: EditorOverlay;
  image: HTMLImageElement | null;
  onSelect: () => void;
  onChange: (patch: Partial<EditorOverlay>) => void;
  registerNode: (node: Konva.Node | null) => void;
}) {
  const ref = useRef<Konva.Image | null>(null);
  useEffect(() => {
    registerNode(ref.current);
    return () => registerNode(null);
  }, [registerNode, image]);
  if (!image) return null;
  return (
    <KonvaImage
      ref={ref}
      image={image}
      x={overlay.x}
      y={overlay.y}
      width={overlay.width}
      height={overlay.height}
      rotation={overlay.rotation}
      draggable
      onClick={onSelect}
      onTap={onSelect}
      onDragEnd={(e) => onChange({ x: e.target.x(), y: e.target.y() })}
      onTransformEnd={(e) => {
        const node = e.target as Konva.Image;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        node.scaleX(1);
        node.scaleY(1);
        onChange({
          x: node.x(),
          y: node.y(),
          width: Math.max(20, node.width() * scaleX),
          height: Math.max(20, node.height() * scaleY),
          rotation: node.rotation(),
        });
      }}
    />
  );
}

// ── Track row wrapper ────────────────────────────────────────────────────────
// (Extracted to ./editor/TrackLane — TrackLane, TimelineRuler, TimelinePlayhead,
// TimelineClipBlock.)

// ── Add menus ─────────────────────────────────────────────────────────────────

function AddClipMenu({
  videos,
  onAdd,
}: {
  videos: VideoStudioVideo[];
  onAdd: (id: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <Plus className="w-3.5 h-3.5 mr-1" /> Clip
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel className="text-xs">Add a clip from your library</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {videos.length === 0 && (
          <DropdownMenuItem disabled className="text-xs">
            No videos yet
          </DropdownMenuItem>
        )}
        {videos.map((v) => (
          <DropdownMenuItem key={v.id} onClick={() => onAdd(v.id)} className="text-xs">
            <Film className="w-3 h-3 mr-2 shrink-0" />
            <span className="truncate max-w-[200px]">{v.prompt}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddImageMenu({
  images,
  onAdd,
}: {
  images: ImageStudioImage[];
  onAdd: (id: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <ImagePlus className="w-3.5 h-3.5 mr-1" /> Image
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel className="text-xs">Overlay an image</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {images.length === 0 && (
          <DropdownMenuItem disabled className="text-xs">
            No images yet
          </DropdownMenuItem>
        )}
        {images.map((img) => (
          <DropdownMenuItem key={img.id} onClick={() => onAdd(img.id)} className="text-xs">
            <ImagePlus className="w-3 h-3 mr-2 shrink-0" />
            <span className="truncate max-w-[200px]">{img.prompt}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddAudioMenu({
  videos,
  onAdd,
}: {
  videos: VideoStudioVideo[];
  onAdd: (id: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <Music className="w-3.5 h-3.5 mr-1" /> Audio
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel className="text-xs">Add audio from a video's track</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {videos.length === 0 && (
          <DropdownMenuItem disabled className="text-xs">
            No videos yet
          </DropdownMenuItem>
        )}
        {videos.map((v) => (
          <DropdownMenuItem key={v.id} onClick={() => onAdd(v.id)} className="text-xs">
            <Music className="w-3 h-3 mr-2 shrink-0" />
            <span className="truncate max-w-[200px]">{v.prompt}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VoiceoverButton({
  onGenerated,
}: {
  onGenerated: (filePath: string, duration: number, label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [engine, setEngine] = useState<"piper" | "elevenlabs">("piper");
  const [voice, setVoice] = useState<string>("");
  const [generating, setGenerating] = useState(false);

  const { data: caps } = useQuery({
    queryKey: ["voice", "capabilities"],
    queryFn: () => VoiceAssistantClient.getCapabilities(),
    enabled: open,
    staleTime: 60_000,
  });

  const piperVoices = caps?.installedPiperModels ?? [];

  useEffect(() => {
    if (caps && !caps.hasPiper) setEngine("elevenlabs");
  }, [caps]);

  const handleGenerate = useCallback(async () => {
    const script = text.trim();
    if (!script) {
      toast.error("Enter some text for the voiceover");
      return;
    }
    setGenerating(true);
    try {
      const result = await IpcClient.getInstance().generateVoiceover({
        text: script,
        voice: engine === "piper" && voice ? voice : undefined,
        engine,
      });
      const label = script.length > 24 ? `${script.slice(0, 24)}…` : script;
      onGenerated(result.filePath, result.duration, label);
      toast.success("Voiceover added to timeline");
      setText("");
      setOpen(false);
    } catch (err) {
      toast.error(
        `Voiceover failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      setGenerating(false);
    }
  }, [text, engine, voice, onGenerated]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <Mic className="w-3.5 h-3.5 mr-1" /> Voiceover
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="start">
        <div className="space-y-1">
          <Label className="text-xs font-medium">AI Voiceover</Label>
          <p className="text-[10px] text-muted-foreground">
            Type a script and generate narration. It's added as an audio track at the
            playhead and mixed into the final render.
          </p>
        </div>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Enter the text you want spoken…"
          className="min-h-24 text-xs"
        />
        <div className="space-y-1">
          <Label className="text-[11px]">Engine</Label>
          <Select value={engine} onValueChange={(v) => setEngine(v as "piper" | "elevenlabs")}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="piper" disabled={caps != null && !caps.hasPiper} className="text-xs">
                Local (Piper){caps != null && !caps.hasPiper ? " — not installed" : ""}
              </SelectItem>
              <SelectItem value="elevenlabs" className="text-xs">
                ElevenLabs (cloud)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {engine === "piper" && piperVoices.length > 0 && (
          <div className="space-y-1">
            <Label className="text-[11px]">Voice</Label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Default voice" />
              </SelectTrigger>
              <SelectContent>
                {piperVoices.map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <Button
          size="sm"
          className="w-full"
          onClick={handleGenerate}
          disabled={generating || !text.trim()}
        >
          {generating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <Mic className="w-3.5 h-3.5 mr-1" /> Generate &amp; Add
            </>
          )}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

// ── Property panels ──────────────────────────────────────────────────────────

function NumField({
  label,
  value,
  min,
  max,
  step = 0.1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-[10px] text-muted-foreground tabular-nums">{value.toFixed(2)}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

function ClipProperties({
  clip,
  onChange,
  isLast,
  isFirst,
  onDelete,
  onMoveLeft,
  onMoveRight,
}: {
  clip: EditorClip;
  onChange: (patch: Partial<EditorClip>) => void;
  isLast: boolean;
  isFirst: boolean;
  onDelete: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Film className="w-4 h-4 text-violet-500" />
        <span className="text-sm font-medium truncate flex-1">{clip.name}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="flex-1" onClick={onMoveLeft} disabled={isFirst}>
          <ArrowLeft className="w-3.5 h-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={onMoveRight} disabled={isLast}>
          <ArrowRight className="w-3.5 h-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="flex-1 text-destructive" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
      <NumField
        label="Trim start (s)"
        value={clip.trimStart}
        min={0}
        max={Math.max(0, clip.trimEnd - 0.1)}
        onChange={(v) => onChange({ trimStart: v })}
      />
      <NumField
        label="Trim end (s)"
        value={clip.trimEnd}
        min={clip.trimStart + 0.1}
        max={clip.srcDuration}
        onChange={(v) => onChange({ trimEnd: v })}
      />
      <NumField
        label="Speed (×)"
        value={clip.speed}
        min={0.5}
        max={2}
        step={0.05}
        onChange={(v) => onChange({ speed: v })}
      />
      <NumField
        label="Volume"
        value={clip.volume}
        min={0}
        max={2}
        step={0.05}
        onChange={(v) => onChange({ volume: v })}
      />
      {!isLast && (
        <div className="space-y-1">
          <Label className="text-xs">Transition to next clip</Label>
          <Select
            value={clip.transition?.type ?? "none"}
            onValueChange={(val) =>
              onChange({
                transition:
                  val === "none"
                    ? undefined
                    : { type: val as TransitionType, duration: clip.transition?.duration ?? 0.5 },
              })
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSITIONS.map((t) => (
                <SelectItem key={t.value} value={t.value} className="text-xs">
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {clip.transition && (
            <NumField
              label="Transition duration (s)"
              value={clip.transition.duration}
              min={0.1}
              max={2}
              step={0.1}
              onChange={(v) =>
                onChange({ transition: { ...clip.transition!, duration: v } })
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function OverlayProperties({
  overlay,
  onChange,
  maxDuration,
  onDelete,
}: {
  overlay: EditorOverlay;
  onChange: (patch: Partial<EditorOverlay>) => void;
  maxDuration: number;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {overlay.kind === "text" ? (
          <TypeIcon className="w-4 h-4 text-sky-500" />
        ) : (
          <ImagePlus className="w-4 h-4 text-sky-500" />
        )}
        <span className="text-sm font-medium flex-1">
          {overlay.kind === "text" ? "Text overlay" : "Image overlay"}
        </span>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {overlay.kind === "text" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs">Text</Label>
            <Textarea
              value={overlay.text ?? ""}
              onChange={(e) => onChange({ text: e.target.value })}
              className="text-sm min-h-[60px]"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Font</Label>
            <Select value={overlay.fontFamily} onValueChange={(v) => onChange({ fontFamily: v })}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_FAMILIES.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <NumField
            label="Font size"
            value={overlay.fontSize ?? 48}
            min={8}
            max={400}
            step={1}
            onChange={(v) => onChange({ fontSize: Math.round(v) })}
          />
          <div className="flex items-center gap-2">
            <div className="space-y-1 flex-1">
              <Label className="text-xs">Color</Label>
              <input
                type="color"
                value={overlay.fill ?? "#ffffff"}
                onChange={(e) => onChange({ fill: e.target.value })}
                className="w-full h-8 rounded cursor-pointer"
              />
            </div>
            <div className="space-y-1 flex-1">
              <Label className="text-xs">Background</Label>
              <input
                type="color"
                value={overlay.backgroundColor || "#000000"}
                onChange={(e) => onChange({ backgroundColor: e.target.value })}
                className="w-full h-8 rounded cursor-pointer"
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Background fill</Label>
            <Switch
              checked={!!overlay.backgroundColor}
              onCheckedChange={(on) => onChange({ backgroundColor: on ? "#000000" : "" })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Alignment</Label>
            <Select
              value={overlay.align ?? "center"}
              onValueChange={(v) => onChange({ align: v as "left" | "center" | "right" })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="left" className="text-xs">Left</SelectItem>
                <SelectItem value="center" className="text-xs">Center</SelectItem>
                <SelectItem value="right" className="text-xs">Right</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Bold</Label>
            <Switch
              checked={(overlay.fontStyle ?? "").includes("bold")}
              onCheckedChange={(on) => onChange({ fontStyle: on ? "bold" : "normal" })}
            />
          </div>
        </>
      )}

      <div className="pt-2 border-t space-y-3">
        <NumField
          label="Start (s)"
          value={overlay.start}
          min={0}
          max={Math.max(0, maxDuration)}
          onChange={(v) => onChange({ start: v })}
        />
        <NumField
          label="End (s)"
          value={overlay.end}
          min={overlay.start + 0.2}
          max={Math.max(overlay.start + 0.2, maxDuration)}
          onChange={(v) => onChange({ end: v })}
        />
        <NumField
          label="Fade in (s)"
          value={overlay.fadeIn}
          min={0}
          max={2}
          onChange={(v) => onChange({ fadeIn: v })}
        />
        <NumField
          label="Fade out (s)"
          value={overlay.fadeOut}
          min={0}
          max={2}
          onChange={(v) => onChange({ fadeOut: v })}
        />
        <NumField
          label="Rotation (°)"
          value={overlay.rotation}
          min={-180}
          max={180}
          step={1}
          onChange={(v) => onChange({ rotation: Math.round(v) })}
        />
      </div>
    </div>
  );
}

function AudioProperties({
  audio,
  onChange,
  maxDuration,
  onDelete,
}: {
  audio: EditorAudio;
  onChange: (patch: Partial<EditorAudio>) => void;
  maxDuration: number;
  onDelete: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Music className="w-4 h-4 text-emerald-500" />
        <span className="text-sm font-medium truncate flex-1">{audio.label}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={onDelete}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>
      <NumField
        label="Start on timeline (s)"
        value={audio.start}
        min={0}
        max={Math.max(0, maxDuration)}
        onChange={(v) => onChange({ start: v })}
      />
      <NumField
        label="Trim start (s)"
        value={audio.trimStart}
        min={0}
        max={Math.max(0, audio.trimEnd - 0.1)}
        onChange={(v) => onChange({ trimStart: v })}
      />
      <NumField
        label="Trim end (s)"
        value={audio.trimEnd}
        min={audio.trimStart + 0.1}
        max={audio.trimEnd + 60}
        onChange={(v) => onChange({ trimEnd: v })}
      />
      <NumField
        label="Volume"
        value={audio.volume}
        min={0}
        max={2}
        step={0.05}
        onChange={(v) => onChange({ volume: v })}
      />
    </div>
  );
}

function ProjectSettings({
  width,
  height,
  fps,
  backgroundColor,
  muteClipAudio,
  onResolution,
  onFps,
  onBackground,
  onMuteClipAudio,
}: {
  width: number;
  height: number;
  fps: number;
  backgroundColor: string;
  muteClipAudio: boolean;
  onResolution: (w: number, h: number) => void;
  onFps: (v: number) => void;
  onBackground: (v: string) => void;
  onMuteClipAudio: (v: boolean) => void;
}) {
  const current = `${width}x${height}`;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Settings2 className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium">Project settings</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Select a clip, overlay, or audio track to edit it — or adjust the output settings below.
      </p>
      <div className="space-y-1">
        <Label className="text-xs">Resolution</Label>
        <Select
          value={current}
          onValueChange={(v) => {
            const preset = RESOLUTIONS.find((r) => `${r.width}x${r.height}` === v);
            if (preset) onResolution(preset.width, preset.height);
          }}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Custom" />
          </SelectTrigger>
          <SelectContent>
            {RESOLUTIONS.map((r) => (
              <SelectItem key={r.label} value={`${r.width}x${r.height}`} className="text-xs">
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Frame rate</Label>
        <Select value={String(fps)} onValueChange={(v) => onFps(Number(v))}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[24, 25, 30, 50, 60].map((f) => (
              <SelectItem key={f} value={String(f)} className="text-xs">
                {f} fps
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Background (letterbox) color</Label>
        <input
          type="color"
          value={backgroundColor}
          onChange={(e) => onBackground(e.target.value)}
          className="w-full h-8 rounded cursor-pointer"
        />
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-xs">Mute all clip audio</Label>
        <Switch checked={muteClipAudio} onCheckedChange={onMuteClipAudio} />
      </div>
    </div>
  );
}
