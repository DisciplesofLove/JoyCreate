import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Line,
  Rect,
  Ellipse,
  Text as KonvaText,
  Transformer,
} from "react-konva";
import Konva from "konva";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  X,
  MousePointer2,
  Type as TypeIcon,
  Square,
  Circle as CircleIcon,
  Minus,
  Pen,
  Crop,
  Paintbrush,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Trash2,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
  Download,
  Save,
  Wand2,
  Loader2,
  Layers as LayersIcon,
  SlidersHorizontal,
  Check,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

type EditorTool =
  | "select"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "draw"
  | "crop"
  | "mask";

interface BaseElement {
  id: string;
  type: "text" | "rect" | "ellipse" | "line" | "draw";
  x: number;
  y: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  name: string;
}

interface TextElement extends BaseElement {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily: string;
  fill: string;
  fontStyle: string; // "normal" | "bold" | "italic" | "italic bold"
  align: string;
  width: number;
}

interface RectElement extends BaseElement {
  type: "rect";
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
}

interface EllipseElement extends BaseElement {
  type: "ellipse";
  radiusX: number;
  radiusY: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

interface LineElement extends BaseElement {
  type: "line";
  points: number[];
  stroke: string;
  strokeWidth: number;
}

interface DrawElement extends BaseElement {
  type: "draw";
  points: number[];
  stroke: string;
  strokeWidth: number;
}

type EditorElement =
  | TextElement
  | RectElement
  | EllipseElement
  | LineElement
  | DrawElement;

interface Adjustments {
  brightness: number; // -100..100
  contrast: number; // -100..100
  saturation: number; // -100..100
  blur: number; // 0..40
  grayscale: boolean;
  sepia: boolean;
  invert: boolean;
}

interface MaskStroke {
  points: number[];
  erase: boolean;
}

interface EditorSnapshot {
  elements: EditorElement[];
  adjustments: Adjustments;
}

const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
  grayscale: false,
  sepia: false,
  invert: false,
};

const FONT_FAMILIES = [
  "Inter",
  "Arial",
  "Helvetica",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Impact",
  "Comic Sans MS",
];

let _idCounter = 0;
function nextId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}_${Date.now()}_${_idCounter}`;
}

function noFilters(adj: Adjustments): boolean {
  return (
    adj.brightness === 0 &&
    adj.contrast === 0 &&
    adj.saturation === 0 &&
    adj.blur === 0 &&
    !adj.grayscale &&
    !adj.sepia &&
    !adj.invert
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function ImageEditor({
  imageId,
  onClose,
}: {
  imageId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const stageRef = useRef<Konva.Stage>(null);
  const baseImageRef = useRef<Konva.Image>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef<Map<string, Konva.Node>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<EditorTool>("select");
  const [elements, setElements] = useState<EditorElement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustments>(DEFAULT_ADJUSTMENTS);
  const [zoom, setZoom] = useState(1);

  const [undoStack, setUndoStack] = useState<EditorSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditorSnapshot[]>([]);

  const [canvasImage, setCanvasImage] = useState<HTMLImageElement | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 1024, h: 1024 });

  // Shape drag-create state
  const drawingRef = useRef(false);
  const newElIdRef = useRef<string | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  // Default styling for new elements
  const [fillColor, setFillColor] = useState("#8b5cf6");
  const [strokeColor, setStrokeColor] = useState("#1e1e1e");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [brushColor, setBrushColor] = useState("#ef4444");
  const [brushSize, setBrushSize] = useState(6);

  // Crop state (in image coords)
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // AI mask state
  const [maskStrokes, setMaskStrokes] = useState<MaskStroke[]>([]);
  const [maskBrush, setMaskBrush] = useState(28);
  const [aiPrompt, setAiPrompt] = useState("");

  const { data: src } = useQuery({
    queryKey: ["image-studio", "thumb", imageId],
    queryFn: () => IpcClient.getInstance().readImageAsBase64(imageId),
    staleTime: Infinity,
  });

  // Load image
  useEffect(() => {
    if (!src) return;
    const img = new window.Image();
    img.src = src;
    img.onload = () => {
      setCanvasImage(img);
      setImgSize({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
    };
  }, [src]);

  // Fit zoom on image load
  useEffect(() => {
    if (!canvasImage || !containerRef.current) return;
    const fit = computeFitZoom();
    setZoom(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasImage]);

  const computeFitZoom = useCallback((): number => {
    const el = containerRef.current;
    if (!el) return 1;
    const pad = 48;
    const availW = el.clientWidth - pad;
    const availH = el.clientHeight - pad;
    if (availW <= 0 || availH <= 0) return 1;
    const z = Math.min(availW / imgSize.w, availH / imgSize.h, 1);
    return Math.max(z, 0.05);
  }, [imgSize]);

  // Apply image filters (Konva requires cache())
  useEffect(() => {
    const node = baseImageRef.current;
    if (!node || !canvasImage) return;
    if (noFilters(adjustments)) {
      node.clearCache();
      node.filters([]);
    } else {
      const filters: typeof Konva.Filters.Brighten[] = [];
      if (adjustments.brightness !== 0) filters.push(Konva.Filters.Brighten);
      if (adjustments.contrast !== 0) filters.push(Konva.Filters.Contrast);
      if (adjustments.saturation !== 0) filters.push(Konva.Filters.HSV);
      if (adjustments.blur > 0) filters.push(Konva.Filters.Blur);
      if (adjustments.grayscale) filters.push(Konva.Filters.Grayscale);
      if (adjustments.sepia) filters.push(Konva.Filters.Sepia);
      if (adjustments.invert) filters.push(Konva.Filters.Invert);
      node.filters(filters);
      node.brightness(adjustments.brightness / 100);
      node.contrast(adjustments.contrast);
      node.saturation(adjustments.saturation / 50);
      node.blurRadius(adjustments.blur);
      node.cache();
    }
    node.getLayer()?.batchDraw();
  }, [adjustments, canvasImage]);

  // Attach transformer to selected node
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    if (selectedId && tool === "select") {
      const node = nodeRefs.current.get(selectedId);
      if (node) {
        tr.nodes([node]);
        tr.getLayer()?.batchDraw();
        return;
      }
    }
    tr.nodes([]);
    tr.getLayer()?.batchDraw();
  }, [selectedId, tool, elements]);

  // ── History ──────────────────────────────────────────────────────────────

  const snapshot = useCallback((): EditorSnapshot => {
    return {
      elements: JSON.parse(JSON.stringify(elements)) as EditorElement[],
      adjustments: { ...adjustments },
    };
  }, [elements, adjustments]);

  const pushHistory = useCallback(() => {
    setUndoStack((prev) => [...prev.slice(-49), snapshot()]);
    setRedoStack([]);
  }, [snapshot]);

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, { elements, adjustments }]);
      setElements(last.elements);
      setAdjustments(last.adjustments);
      setSelectedId(null);
      return prev.slice(0, -1);
    });
  }, [elements, adjustments]);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setUndoStack((u) => [...u, { elements, adjustments }]);
      setElements(last.elements);
      setAdjustments(last.adjustments);
      setSelectedId(null);
      return prev.slice(0, -1);
    });
  }, [elements, adjustments]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !typing) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "Escape") {
        setSelectedId(null);
      } else if (!typing && e.key === "v") setTool("select");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ── Element helpers ────────────────────────────────────────────────────────

  const selectedElement = useMemo(
    () => elements.find((el) => el.id === selectedId) ?? null,
    [elements, selectedId]
  );

  function updateElement(id: string, patch: Partial<EditorElement>) {
    setElements((prev) =>
      prev.map((el) => (el.id === id ? ({ ...el, ...patch } as EditorElement) : el))
    );
  }

  function deleteSelected() {
    if (!selectedId) return;
    pushHistory();
    setElements((prev) => prev.filter((el) => el.id !== selectedId));
    nodeRefs.current.delete(selectedId);
    setSelectedId(null);
  }

  function addText() {
    pushHistory();
    const id = nextId("text");
    const el: TextElement = {
      id,
      type: "text",
      x: imgSize.w / 2 - 150,
      y: imgSize.h / 2 - 30,
      rotation: 0,
      opacity: 1,
      visible: true,
      name: "Text",
      text: "Double-click to edit",
      fontSize: Math.max(32, Math.round(imgSize.w / 16)),
      fontFamily: "Inter",
      fill: fillColor,
      fontStyle: "bold",
      align: "left",
      width: 300,
    };
    setElements((prev) => [...prev, el]);
    setSelectedId(id);
    setTool("select");
  }

  function moveLayer(id: string, dir: "up" | "down") {
    setElements((prev) => {
      const idx = prev.findIndex((el) => el.id === id);
      if (idx === -1) return prev;
      const target = dir === "up" ? idx + 1 : idx - 1;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  // ── Stage pointer handling ──────────────────────────────────────────────────

  function getImagePos(): { x: number; y: number } | null {
    const stage = stageRef.current;
    if (!stage) return null;
    const p = stage.getRelativePointerPosition();
    return p ? { x: p.x, y: p.y } : null;
  }

  function handleStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    const pos = getImagePos();
    if (!pos) return;

    // Clicked on empty area (the stage or base image) → deselect
    const clickedEmpty =
      e.target === e.target.getStage() || e.target.name() === "base-image";

    if (tool === "select") {
      if (clickedEmpty) setSelectedId(null);
      return;
    }

    if (tool === "mask") {
      pushMaskHistory();
      drawingRef.current = true;
      setMaskStrokes((prev) => [...prev, { points: [pos.x, pos.y], erase: false }]);
      return;
    }

    if (tool === "draw") {
      pushHistory();
      const id = nextId("draw");
      drawingRef.current = true;
      newElIdRef.current = id;
      const el: DrawElement = {
        id,
        type: "draw",
        x: 0,
        y: 0,
        rotation: 0,
        opacity: 1,
        visible: true,
        name: "Drawing",
        points: [pos.x, pos.y],
        stroke: brushColor,
        strokeWidth: brushSize,
      };
      setElements((prev) => [...prev, el]);
      return;
    }

    if (tool === "crop") {
      drawingRef.current = true;
      startPosRef.current = pos;
      setCropRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
      return;
    }

    if (tool === "rect" || tool === "ellipse" || tool === "line") {
      pushHistory();
      drawingRef.current = true;
      startPosRef.current = pos;
      const id = nextId(tool);
      newElIdRef.current = id;
      if (tool === "rect") {
        const el: RectElement = {
          id, type: "rect", x: pos.x, y: pos.y, rotation: 0, opacity: 1, visible: true,
          name: "Rectangle", width: 1, height: 1, fill: fillColor, stroke: strokeColor,
          strokeWidth, cornerRadius: 0,
        };
        setElements((prev) => [...prev, el]);
      } else if (tool === "ellipse") {
        const el: EllipseElement = {
          id, type: "ellipse", x: pos.x, y: pos.y, rotation: 0, opacity: 1, visible: true,
          name: "Ellipse", radiusX: 1, radiusY: 1, fill: fillColor, stroke: strokeColor, strokeWidth,
        };
        setElements((prev) => [...prev, el]);
      } else {
        const el: LineElement = {
          id, type: "line", x: 0, y: 0, rotation: 0, opacity: 1, visible: true,
          name: "Line", points: [pos.x, pos.y, pos.x, pos.y], stroke: strokeColor, strokeWidth,
        };
        setElements((prev) => [...prev, el]);
      }
      return;
    }

    if (tool === "text") {
      addText();
    }
  }

  function handleStageMouseMove() {
    if (!drawingRef.current) return;
    const pos = getImagePos();
    if (!pos) return;

    if (tool === "mask") {
      setMaskStrokes((prev) => {
        const last = prev[prev.length - 1];
        if (!last) return prev;
        return [...prev.slice(0, -1), { ...last, points: [...last.points, pos.x, pos.y] }];
      });
      return;
    }

    if (tool === "draw") {
      const id = newElIdRef.current;
      if (!id) return;
      setElements((prev) =>
        prev.map((el) =>
          el.id === id && el.type === "draw"
            ? { ...el, points: [...el.points, pos.x, pos.y] }
            : el
        )
      );
      return;
    }

    if (tool === "crop" && startPosRef.current) {
      const s = startPosRef.current;
      setCropRect({
        x: Math.min(s.x, pos.x),
        y: Math.min(s.y, pos.y),
        w: Math.abs(pos.x - s.x),
        h: Math.abs(pos.y - s.y),
      });
      return;
    }

    const id = newElIdRef.current;
    const s = startPosRef.current;
    if (!id || !s) return;

    if (tool === "rect") {
      setElements((prev) =>
        prev.map((el) =>
          el.id === id && el.type === "rect"
            ? {
                ...el,
                x: Math.min(s.x, pos.x),
                y: Math.min(s.y, pos.y),
                width: Math.abs(pos.x - s.x),
                height: Math.abs(pos.y - s.y),
              }
            : el
        )
      );
    } else if (tool === "ellipse") {
      setElements((prev) =>
        prev.map((el) =>
          el.id === id && el.type === "ellipse"
            ? {
                ...el,
                x: (s.x + pos.x) / 2,
                y: (s.y + pos.y) / 2,
                radiusX: Math.abs(pos.x - s.x) / 2,
                radiusY: Math.abs(pos.y - s.y) / 2,
              }
            : el
        )
      );
    } else if (tool === "line") {
      setElements((prev) =>
        prev.map((el) =>
          el.id === id && el.type === "line"
            ? { ...el, points: [s.x, s.y, pos.x, pos.y] }
            : el
        )
      );
    }
  }

  function handleStageMouseUp() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const createdId = newElIdRef.current;
    newElIdRef.current = null;
    startPosRef.current = null;

    if (tool === "rect" || tool === "ellipse" || tool === "line" || tool === "draw") {
      if (createdId) setSelectedId(createdId);
      if (tool !== "draw") setTool("select");
    }
  }

  // ── Transform / drag commit ─────────────────────────────────────────────────

  function commitNodeTransform(id: string) {
    const node = nodeRefs.current.get(id);
    if (!node) return;
    const el = elements.find((x) => x.id === id);
    if (!el) return;

    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);

    if (el.type === "rect") {
      updateElement(id, {
        x: node.x(),
        y: node.y(),
        rotation: node.rotation(),
        width: Math.max(2, (el as RectElement).width * scaleX),
        height: Math.max(2, (el as RectElement).height * scaleY),
      } as Partial<RectElement>);
    } else if (el.type === "ellipse") {
      updateElement(id, {
        x: node.x(),
        y: node.y(),
        rotation: node.rotation(),
        radiusX: Math.max(1, (el as EllipseElement).radiusX * scaleX),
        radiusY: Math.max(1, (el as EllipseElement).radiusY * scaleY),
      } as Partial<EllipseElement>);
    } else if (el.type === "text") {
      updateElement(id, {
        x: node.x(),
        y: node.y(),
        rotation: node.rotation(),
        width: Math.max(20, (el as TextElement).width * scaleX),
        fontSize: Math.max(6, (el as TextElement).fontSize * scaleY),
      } as Partial<TextElement>);
    } else {
      updateElement(id, { x: node.x(), y: node.y(), rotation: node.rotation() });
    }
  }

  // ── AI mask ─────────────────────────────────────────────────────────────────

  const [, setMaskUndo] = useState<MaskStroke[][]>([]);
  function pushMaskHistory() {
    setMaskUndo((prev) => [...prev.slice(-49), maskStrokes]);
  }

  function getMaskBase64(): string {
    const canvas = document.createElement("canvas");
    canvas.width = imgSize.w;
    canvas.height = imgSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, imgSize.w, imgSize.h);
    ctx.strokeStyle = "white";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = maskBrush;
    maskStrokes.forEach((stroke) => {
      ctx.beginPath();
      for (let i = 0; i < stroke.points.length - 1; i += 2) {
        if (i === 0) ctx.moveTo(stroke.points[i], stroke.points[i + 1]);
        else ctx.lineTo(stroke.points[i], stroke.points[i + 1]);
      }
      ctx.stroke();
    });
    return canvas.toDataURL("image/png");
  }

  const aiEditMutation = useMutation({
    mutationFn: (params: { maskBase64: string; prompt: string }) =>
      IpcClient.getInstance().editImage({
        imageId,
        maskBase64: params.maskBase64,
        prompt: params.prompt,
        provider: "openai",
        model: "dall-e-2",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["image-studio", "list"] });
      toast.success("AI edit applied — new image added to gallery");
      setMaskStrokes([]);
      setAiPrompt("");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleApplyAIEdit() {
    if (!aiPrompt.trim()) return toast.error("Describe what to generate in the masked area");
    if (maskStrokes.length === 0) return toast.error("Paint a mask over the area to change");
    aiEditMutation.mutate({ maskBase64: getMaskBase64(), prompt: aiPrompt.trim() });
  }

  // ── Crop ──────────────────────────────────────────────────────────────────

  function applyCrop() {
    if (!cropRect || cropRect.w < 5 || cropRect.h < 5) {
      toast.error("Draw a larger crop region first");
      return;
    }
    const dataUrl = flattenToDataURL(cropRect);
    if (!dataUrl) return;
    const img = new window.Image();
    img.src = dataUrl;
    img.onload = () => {
      pushHistory();
      setCanvasImage(img);
      setImgSize({ w: Math.round(cropRect.w), h: Math.round(cropRect.h) });
      setElements([]);
      nodeRefs.current.clear();
      setSelectedId(null);
      setAdjustments(DEFAULT_ADJUSTMENTS);
      setCropRect(null);
      setTool("select");
      requestAnimationFrame(() => setZoom(computeFitZoom()));
      toast.success("Cropped");
    };
  }

  // ── Flatten / export ────────────────────────────────────────────────────────

  function flattenToDataURL(region?: { x: number; y: number; w: number; h: number }): string | null {
    const stage = stageRef.current;
    if (!stage) return null;
    // Detach transformer + hide overlays for a clean export
    transformerRef.current?.nodes([]);
    const prevSelected = selectedId;
    setSelectedId(null);
    const opts: {
      pixelRatio: number;
      mimeType: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    } = {
      pixelRatio: 1 / zoom,
      mimeType: "image/png",
    };
    if (region) {
      opts.x = region.x * zoom;
      opts.y = region.y * zoom;
      opts.width = region.w * zoom;
      opts.height = region.h * zoom;
    }
    const url = stage.toDataURL(opts);
    if (prevSelected) setSelectedId(prevSelected);
    return url;
  }

  const saveMutation = useMutation({
    mutationFn: (dataUrl: string) =>
      IpcClient.getInstance().saveEditedImage({
        imageBase64: dataUrl,
        sourceImageId: imageId,
        width: Math.round(imgSize.w),
        height: Math.round(imgSize.h),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["image-studio", "list"] });
      toast.success("Saved as new image in gallery");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleSaveToGallery() {
    const url = flattenToDataURL();
    if (!url) return toast.error("Nothing to save");
    saveMutation.mutate(url);
  }

  function handleDownload() {
    const url = flattenToDataURL();
    if (!url) return toast.error("Nothing to export");
    const a = document.createElement("a");
    a.href = url;
    a.download = `joycreate-edit-${Date.now()}.png`;
    a.click();
    toast.success("PNG downloaded");
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────

  const stageW = imgSize.w * zoom;
  const stageH = imgSize.h * zoom;

  function zoomBy(delta: number) {
    setZoom((z) => Math.min(Math.max(z + delta, 0.05), 5));
  }

  const cursorClass =
    tool === "select" ? "cursor-default" : tool === "draw" || tool === "mask" ? "cursor-crosshair" : "cursor-crosshair";

  // ── Render ──────────────────────────────────────────────────────────────────

  const TOOLBAR: { id: EditorTool; icon: React.ReactNode; label: string }[] = [
    { id: "select", icon: <MousePointer2 className="w-4 h-4" />, label: "Select / Move (V)" },
    { id: "text", icon: <TypeIcon className="w-4 h-4" />, label: "Text" },
    { id: "rect", icon: <Square className="w-4 h-4" />, label: "Rectangle" },
    { id: "ellipse", icon: <CircleIcon className="w-4 h-4" />, label: "Ellipse" },
    { id: "line", icon: <Minus className="w-4 h-4" />, label: "Line" },
    { id: "draw", icon: <Pen className="w-4 h-4" />, label: "Draw (freehand)" },
    { id: "crop", icon: <Crop className="w-4 h-4" />, label: "Crop" },
    { id: "mask", icon: <Paintbrush className="w-4 h-4" />, label: "AI Inpaint mask" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-background">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Image Editor</span>
          <span className="text-xs text-muted-foreground">
            {Math.round(imgSize.w)} × {Math.round(imgSize.h)}
          </span>
        </div>

        <TooltipProvider delayDuration={200}>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={undoStack.length === 0} onClick={handleUndo}>
                  <Undo2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p className="text-xs">Undo (Ctrl+Z)</p></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={redoStack.length === 0} onClick={handleRedo}>
                  <Redo2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p className="text-xs">Redo (Ctrl+Y)</p></TooltipContent>
            </Tooltip>

            <div className="w-px h-5 bg-border mx-1" />

            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => zoomBy(-0.1)}>
              <ZoomOut className="w-4 h-4" />
            </Button>
            <span className="text-xs w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => zoomBy(0.1)}>
              <ZoomIn className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setZoom(computeFitZoom())}>
              <Maximize2 className="w-4 h-4" />
            </Button>
          </div>
        </TooltipProvider>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8" onClick={handleDownload}>
            <Download className="w-3.5 h-3.5 mr-1.5" /> Download
          </Button>
          <Button size="sm" className="h-8" onClick={handleSaveToGallery} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
            Save to Gallery
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left tool rail */}
        <div className="flex flex-col items-center gap-1 px-1.5 py-2 border-r bg-muted/30">
          <TooltipProvider delayDuration={200}>
            {TOOLBAR.map((t) => (
              <Tooltip key={t.id}>
                <TooltipTrigger asChild>
                  <Button
                    variant={tool === t.id ? "secondary" : "ghost"}
                    size="sm"
                    className="h-9 w-9 p-0"
                    onClick={() => {
                      setTool(t.id);
                      if (t.id !== "select") setSelectedId(null);
                      if (t.id !== "crop") setCropRect(null);
                    }}
                  >
                    {t.icon}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right"><p className="text-xs">{t.label}</p></TooltipContent>
              </Tooltip>
            ))}
            <div className="h-px w-6 bg-border my-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 w-9 p-0 text-destructive"
                  disabled={!selectedId}
                  onClick={deleteSelected}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right"><p className="text-xs">Delete (Del)</p></TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Canvas viewport */}
        <div ref={containerRef} className="flex-1 overflow-auto bg-[#1a1a1a] flex items-center justify-center p-6">
          {canvasImage ? (
            <div className="shadow-2xl" style={{ width: stageW, height: stageH }}>
              <Stage
                ref={stageRef}
                width={stageW}
                height={stageH}
                scaleX={zoom}
                scaleY={zoom}
                className={cursorClass}
                onMouseDown={handleStageMouseDown}
                onMouseMove={handleStageMouseMove}
                onMouseUp={handleStageMouseUp}
              >
                <Layer>
                  <KonvaImage
                    ref={baseImageRef}
                    name="base-image"
                    image={canvasImage}
                    width={imgSize.w}
                    height={imgSize.h}
                  />
                </Layer>

                <Layer>
                  {elements.map((el) => {
                    if (!el.visible) return null;
                    const common = {
                      id: el.id,
                      x: el.x,
                      y: el.y,
                      rotation: el.rotation,
                      opacity: el.opacity,
                      draggable: tool === "select",
                      ref: (node: Konva.Node | null) => {
                        if (node) nodeRefs.current.set(el.id, node);
                        else nodeRefs.current.delete(el.id);
                      },
                      onClick: () => {
                        if (tool === "select") setSelectedId(el.id);
                      },
                      onTap: () => {
                        if (tool === "select") setSelectedId(el.id);
                      },
                      onDragEnd: () => commitNodeTransform(el.id),
                      onTransformEnd: () => commitNodeTransform(el.id),
                    };
                    if (el.type === "text") {
                      return (
                        <KonvaText
                          key={el.id}
                          {...common}
                          text={el.text}
                          fontSize={el.fontSize}
                          fontFamily={el.fontFamily}
                          fill={el.fill}
                          fontStyle={el.fontStyle}
                          align={el.align}
                          width={el.width}
                          onDblClick={() => {
                            setSelectedId(el.id);
                            setTool("select");
                          }}
                        />
                      );
                    }
                    if (el.type === "rect") {
                      return (
                        <Rect
                          key={el.id}
                          {...common}
                          width={el.width}
                          height={el.height}
                          fill={el.fill}
                          stroke={el.stroke}
                          strokeWidth={el.strokeWidth}
                          cornerRadius={el.cornerRadius}
                        />
                      );
                    }
                    if (el.type === "ellipse") {
                      return (
                        <Ellipse
                          key={el.id}
                          {...common}
                          radiusX={el.radiusX}
                          radiusY={el.radiusY}
                          fill={el.fill}
                          stroke={el.stroke}
                          strokeWidth={el.strokeWidth}
                        />
                      );
                    }
                    // line / draw
                    return (
                      <Line
                        key={el.id}
                        {...common}
                        points={el.points}
                        stroke={el.stroke}
                        strokeWidth={el.strokeWidth}
                        lineCap="round"
                        lineJoin="round"
                        tension={el.type === "draw" ? 0.3 : 0}
                        hitStrokeWidth={Math.max(el.strokeWidth, 12)}
                      />
                    );
                  })}
                  <Transformer
                    ref={transformerRef}
                    rotateEnabled
                    boundBoxFunc={(oldBox, newBox) =>
                      newBox.width < 5 || newBox.height < 5 ? oldBox : newBox
                    }
                  />
                </Layer>

                {/* AI mask overlay */}
                {tool === "mask" && (
                  <Layer listening={false}>
                    {maskStrokes.map((stroke, i) => (
                      <Line
                        key={i}
                        points={stroke.points}
                        stroke="rgba(139,92,246,0.55)"
                        strokeWidth={maskBrush}
                        lineCap="round"
                        lineJoin="round"
                      />
                    ))}
                  </Layer>
                )}

                {/* Crop overlay */}
                {cropRect && (
                  <Layer listening={false}>
                    <Rect
                      x={cropRect.x}
                      y={cropRect.y}
                      width={cropRect.w}
                      height={cropRect.h}
                      stroke="#22d3ee"
                      strokeWidth={2 / zoom}
                      dash={[8 / zoom, 6 / zoom]}
                      fill="rgba(34,211,238,0.08)"
                    />
                  </Layer>
                )}
              </Stage>
            </div>
          ) : (
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Right panel */}
        <div className="w-72 shrink-0 border-l bg-background flex flex-col">
          <Tabs defaultValue="properties" className="flex flex-col flex-1 overflow-hidden">
            <TabsList className="grid grid-cols-3 m-2">
              <TabsTrigger value="properties" className="text-xs">Style</TabsTrigger>
              <TabsTrigger value="layers" className="text-xs">Layers</TabsTrigger>
              <TabsTrigger value="adjust" className="text-xs">Adjust</TabsTrigger>
            </TabsList>

            {/* Properties / style tab */}
            <TabsContent value="properties" className="flex-1 overflow-hidden m-0">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-4 p-3">
                  {tool === "mask" ? (
                    <MaskPanel
                      aiPrompt={aiPrompt}
                      setAiPrompt={setAiPrompt}
                      maskBrush={maskBrush}
                      setMaskBrush={setMaskBrush}
                      hasMask={maskStrokes.length > 0}
                      onClear={() => setMaskStrokes([])}
                      onUndo={() => {
                        setMaskUndo((prev) => {
                          if (prev.length === 0) return prev;
                          setMaskStrokes(prev[prev.length - 1]);
                          return prev.slice(0, -1);
                        });
                      }}
                      onApply={handleApplyAIEdit}
                      isApplying={aiEditMutation.isPending}
                    />
                  ) : selectedElement ? (
                    <ElementProperties
                      element={selectedElement}
                      onChange={(patch) => updateElement(selectedElement.id, patch)}
                      onCommit={pushHistory}
                    />
                  ) : (
                    <NewElementDefaults
                      tool={tool}
                      fillColor={fillColor}
                      setFillColor={setFillColor}
                      strokeColor={strokeColor}
                      setStrokeColor={setStrokeColor}
                      strokeWidth={strokeWidth}
                      setStrokeWidth={setStrokeWidth}
                      brushColor={brushColor}
                      setBrushColor={setBrushColor}
                      brushSize={brushSize}
                      setBrushSize={setBrushSize}
                      onApplyCrop={applyCrop}
                      hasCrop={!!cropRect && cropRect.w > 5}
                    />
                  )}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* Layers tab */}
            <TabsContent value="layers" className="flex-1 overflow-hidden m-0">
              <ScrollArea className="h-full">
                <div className="flex flex-col gap-1 p-2">
                  {elements.length === 0 && (
                    <p className="text-xs text-muted-foreground p-2">
                      No layers yet. Add text, shapes or drawings.
                    </p>
                  )}
                  {[...elements].reverse().map((el) => (
                    <div
                      key={el.id}
                      className={`flex items-center gap-1 rounded px-2 py-1.5 text-xs cursor-pointer ${
                        selectedId === el.id ? "bg-secondary" : "hover:bg-muted"
                      }`}
                      onClick={() => {
                        setTool("select");
                        setSelectedId(el.id);
                      }}
                    >
                      <button
                        className="text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          updateElement(el.id, { visible: !el.visible });
                        }}
                      >
                        {el.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                      </button>
                      <span className="flex-1 truncate">
                        {el.type === "text" ? `T  ${(el as TextElement).text.slice(0, 16)}` : el.name}
                      </span>
                      <button
                        className="text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveLayer(el.id, "up");
                        }}
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveLayer(el.id, "down");
                        }}
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          pushHistory();
                          setElements((prev) => prev.filter((x) => x.id !== el.id));
                          nodeRefs.current.delete(el.id);
                          if (selectedId === el.id) setSelectedId(null);
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </TabsContent>

            {/* Adjustments tab */}
            <TabsContent value="adjust" className="flex-1 overflow-hidden m-0">
              <ScrollArea className="h-full">
                <AdjustmentsPanel
                  adjustments={adjustments}
                  setAdjustments={setAdjustments}
                  onCommit={pushHistory}
                />
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

// ── Sub-panels ───────────────────────────────────────────────────────────────

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-7 rounded border cursor-pointer bg-transparent p-0"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-20 text-xs font-mono"
        />
      </div>
    </div>
  );
}

function ElementProperties({
  element,
  onChange,
  onCommit,
}: {
  element: EditorElement;
  onChange: (patch: Partial<EditorElement>) => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs font-semibold uppercase text-muted-foreground">{element.name} properties</p>

      {element.type === "text" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Text</Label>
            <Textarea
              value={element.text}
              onFocus={onCommit}
              onChange={(e) => onChange({ text: e.target.value } as Partial<TextElement>)}
              className="text-xs min-h-[60px] resize-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Font</Label>
            <Select
              value={element.fontFamily}
              onValueChange={(v) => { onCommit(); onChange({ fontFamily: v } as Partial<TextElement>); }}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FONT_FAMILIES.map((f) => (
                  <SelectItem key={f} value={f} className="text-xs">{f}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Font size</Label>
              <span className="text-xs text-muted-foreground">{Math.round(element.fontSize)}px</span>
            </div>
            <Slider
              min={6} max={300} step={1}
              value={[element.fontSize]}
              onValueChange={([v]) => onChange({ fontSize: v } as Partial<TextElement>)}
              onValueCommit={onCommit}
            />
          </div>
          <div className="flex items-center gap-1">
            {(["normal", "bold", "italic", "italic bold"] as const).map((s) => (
              <Button
                key={s}
                variant={element.fontStyle === s ? "secondary" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => { onCommit(); onChange({ fontStyle: s } as Partial<TextElement>); }}
              >
                {s === "normal" ? "R" : s === "bold" ? "B" : s === "italic" ? "I" : "BI"}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {(["left", "center", "right"] as const).map((a) => (
              <Button
                key={a}
                variant={element.align === a ? "secondary" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs capitalize"
                onClick={() => { onCommit(); onChange({ align: a } as Partial<TextElement>); }}
              >
                {a}
              </Button>
            ))}
          </div>
          <ColorField label="Color" value={element.fill} onChange={(v) => { onChange({ fill: v } as Partial<TextElement>); }} />
        </>
      )}

      {element.type === "rect" && (
        <>
          <ColorField label="Fill" value={element.fill} onChange={(v) => onChange({ fill: v } as Partial<RectElement>)} />
          <ColorField label="Stroke" value={element.stroke} onChange={(v) => onChange({ stroke: v } as Partial<RectElement>)} />
          <SliderField label="Stroke width" value={element.strokeWidth} min={0} max={40} onChange={(v) => onChange({ strokeWidth: v } as Partial<RectElement>)} onCommit={onCommit} />
          <SliderField label="Corner radius" value={element.cornerRadius} min={0} max={200} onChange={(v) => onChange({ cornerRadius: v } as Partial<RectElement>)} onCommit={onCommit} />
        </>
      )}

      {element.type === "ellipse" && (
        <>
          <ColorField label="Fill" value={element.fill} onChange={(v) => onChange({ fill: v } as Partial<EllipseElement>)} />
          <ColorField label="Stroke" value={element.stroke} onChange={(v) => onChange({ stroke: v } as Partial<EllipseElement>)} />
          <SliderField label="Stroke width" value={element.strokeWidth} min={0} max={40} onChange={(v) => onChange({ strokeWidth: v } as Partial<EllipseElement>)} onCommit={onCommit} />
        </>
      )}

      {(element.type === "line" || element.type === "draw") && (
        <>
          <ColorField label="Color" value={element.stroke} onChange={(v) => onChange({ stroke: v } as Partial<LineElement>)} />
          <SliderField label="Width" value={element.strokeWidth} min={1} max={60} onChange={(v) => onChange({ strokeWidth: v } as Partial<LineElement>)} onCommit={onCommit} />
        </>
      )}

      <SliderField label="Opacity" value={Math.round(element.opacity * 100)} min={0} max={100} onChange={(v) => onChange({ opacity: v / 100 })} onCommit={onCommit} />
      <SliderField label="Rotation" value={Math.round(element.rotation)} min={-180} max={180} onChange={(v) => onChange({ rotation: v })} onCommit={onCommit} />
    </div>
  );
}

function SliderField({
  label, value, min, max, onChange, onCommit,
}: {
  label: string; value: number; min: number; max: number;
  onChange: (v: number) => void; onCommit?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs text-muted-foreground">{value}</span>
      </div>
      <Slider min={min} max={max} step={1} value={[value]} onValueChange={([v]) => onChange(v)} onValueCommit={onCommit} />
    </div>
  );
}

function NewElementDefaults({
  tool, fillColor, setFillColor, strokeColor, setStrokeColor, strokeWidth, setStrokeWidth,
  brushColor, setBrushColor, brushSize, setBrushSize, onApplyCrop, hasCrop,
}: {
  tool: EditorTool;
  fillColor: string; setFillColor: (v: string) => void;
  strokeColor: string; setStrokeColor: (v: string) => void;
  strokeWidth: number; setStrokeWidth: (v: number) => void;
  brushColor: string; setBrushColor: (v: string) => void;
  brushSize: number; setBrushSize: (v: number) => void;
  onApplyCrop: () => void; hasCrop: boolean;
}) {
  if (tool === "crop") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
          <Crop className="w-3.5 h-3.5" /> Crop
        </p>
        <p className="text-[11px] text-muted-foreground">
          Drag a rectangle on the canvas to mark the crop region, then apply. Cropping flattens all layers.
        </p>
        <Button size="sm" disabled={!hasCrop} onClick={onApplyCrop}>
          <Check className="w-3.5 h-3.5 mr-1.5" /> Apply Crop
        </Button>
      </div>
    );
  }

  if (tool === "draw") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
          <Pen className="w-3.5 h-3.5" /> Brush
        </p>
        <ColorField label="Color" value={brushColor} onChange={setBrushColor} />
        <SliderField label="Size" value={brushSize} min={1} max={60} onChange={setBrushSize} />
      </div>
    );
  }

  if (tool === "rect" || tool === "ellipse" || tool === "line") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground">New {tool} style</p>
        {tool !== "line" && <ColorField label="Fill" value={fillColor} onChange={setFillColor} />}
        <ColorField label="Stroke" value={strokeColor} onChange={setStrokeColor} />
        <SliderField label="Stroke width" value={strokeWidth} min={0} max={40} onChange={setStrokeWidth} />
        <p className="text-[11px] text-muted-foreground">Drag on the canvas to draw the shape.</p>
      </div>
    );
  }

  if (tool === "text") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
          <TypeIcon className="w-3.5 h-3.5" /> Text
        </p>
        <ColorField label="Color" value={fillColor} onChange={setFillColor} />
        <p className="text-[11px] text-muted-foreground">Click the canvas to drop a text box, then edit it here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <LayersIcon className="w-8 h-8 text-muted-foreground/40" />
      <p className="text-xs text-muted-foreground">
        Pick a tool to add text, shapes or drawings — or select a layer to edit it.
      </p>
    </div>
  );
}

function MaskPanel({
  aiPrompt, setAiPrompt, maskBrush, setMaskBrush, hasMask, onClear, onUndo, onApply, isApplying,
}: {
  aiPrompt: string; setAiPrompt: (v: string) => void;
  maskBrush: number; setMaskBrush: (v: number) => void;
  hasMask: boolean; onClear: () => void; onUndo: () => void;
  onApply: () => void; isApplying: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
        <Wand2 className="w-3.5 h-3.5" /> AI Inpaint
      </p>
      <p className="text-[11px] text-muted-foreground">
        Paint over the area you want to replace, describe the result, then apply. Creates a new gallery image (OpenAI).
      </p>
      <SliderField label="Brush size" value={maskBrush} min={4} max={120} onChange={setMaskBrush} />
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" disabled={!hasMask} onClick={onUndo}>
          <Undo2 className="w-3 h-3 mr-1" /> Undo
        </Button>
        <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" disabled={!hasMask} onClick={onClear}>
          Clear
        </Button>
      </div>
      <Textarea
        placeholder="Replace the sky with a sunset…"
        value={aiPrompt}
        onChange={(e) => setAiPrompt(e.target.value)}
        className="text-xs min-h-[60px] resize-none"
      />
      <Button size="sm" onClick={onApply} disabled={isApplying} className="w-full">
        {isApplying ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5 mr-1.5" />}
        Apply AI Edit
      </Button>
    </div>
  );
}

function AdjustmentsPanel({
  adjustments, setAdjustments, onCommit,
}: {
  adjustments: Adjustments;
  setAdjustments: React.Dispatch<React.SetStateAction<Adjustments>>;
  onCommit: () => void;
}) {
  const set = (patch: Partial<Adjustments>) => setAdjustments((a) => ({ ...a, ...patch }));
  return (
    <div className="flex flex-col gap-4 p-3">
      <p className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1">
        <SlidersHorizontal className="w-3.5 h-3.5" /> Image adjustments
      </p>
      <SliderField label="Brightness" value={adjustments.brightness} min={-100} max={100} onChange={(v) => set({ brightness: v })} onCommit={onCommit} />
      <SliderField label="Contrast" value={adjustments.contrast} min={-100} max={100} onChange={(v) => set({ contrast: v })} onCommit={onCommit} />
      <SliderField label="Saturation" value={adjustments.saturation} min={-100} max={100} onChange={(v) => set({ saturation: v })} onCommit={onCommit} />
      <SliderField label="Blur" value={adjustments.blur} min={0} max={40} onChange={(v) => set({ blur: v })} onCommit={onCommit} />
      <div className="flex flex-col gap-2 border-t pt-3">
        {([
          ["Grayscale", "grayscale"],
          ["Sepia", "sepia"],
          ["Invert", "invert"],
        ] as const).map(([label, key]) => (
          <div key={key} className="flex items-center justify-between">
            <Label className="text-xs">{label}</Label>
            <Switch
              checked={adjustments[key]}
              onCheckedChange={(c) => { onCommit(); set({ [key]: c } as Partial<Adjustments>); }}
            />
          </div>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="text-xs"
        onClick={() => { onCommit(); setAdjustments(DEFAULT_ADJUSTMENTS); }}
      >
        Reset adjustments
      </Button>
    </div>
  );
}
