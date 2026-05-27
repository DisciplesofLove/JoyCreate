/**
 * Brand Kit page.
 *
 * Lists all brand kits in a side rail and edits the selected one inline.
 * Voice / palette / fonts / "do not" rules get composed into the
 * `{{brandKit}}` block at agent execution time.
 */

import { useEffect, useMemo, useState } from "react";

import {
  useBrandKits,
  useCreateBrandKit,
  useDeleteBrandKit,
  useUpdateBrandKit,
} from "@/hooks/useBrandKits";
import type { BrandKitDto } from "@/ipc/handlers/brand_kit_handlers";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Palette, Plus, Save, Star, Trash2 } from "lucide-react";

interface DraftState {
  name: string;
  description: string;
  tagline: string;
  voiceGuide: string;
  doNot: string;
  primary: string;
  secondary: string;
  accent: string;
  displayFont: string;
  bodyFont: string;
  monoFont: string;
  isDefault: boolean;
}

function toDraft(kit: BrandKitDto | null): DraftState {
  return {
    name: kit?.name ?? "",
    description: kit?.description ?? "",
    tagline: kit?.tagline ?? "",
    voiceGuide: kit?.voiceGuide ?? "",
    doNot: (kit?.doNot ?? []).join("\n"),
    primary: kit?.colorTokens?.primary ?? "#7C3AED",
    secondary: kit?.colorTokens?.secondary ?? "",
    accent: kit?.colorTokens?.accent ?? "",
    displayFont: kit?.fontStack?.display ?? "",
    bodyFont: kit?.fontStack?.body ?? "",
    monoFont: kit?.fontStack?.mono ?? "",
    isDefault: kit?.isDefault ?? false,
  };
}

export default function BrandKitPage() {
  const { data: kits, isLoading, error } = useBrandKits();
  const createMut = useCreateBrandKit();
  const updateMut = useUpdateBrandKit();
  const deleteMut = useDeleteBrandKit();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = useMemo(
    () => kits?.find((k) => k.id === selectedId) ?? null,
    [kits, selectedId],
  );

  const [draft, setDraft] = useState<DraftState>(toDraft(null));

  // When the selected kit changes (or first list arrives), reset draft.
  useEffect(() => {
    if (selectedId === null && kits && kits.length > 0) {
      setSelectedId(kits[0].id);
    }
  }, [kits, selectedId]);

  useEffect(() => {
    setDraft(toDraft(selected));
  }, [selected]);

  function handleField<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleCreate() {
    const created = await createMut.mutateAsync({
      name: "New Brand Kit",
      colorTokens: { primary: "#7C3AED" },
    });
    setSelectedId(created.id);
  }

  async function handleSave() {
    if (!selected) return;
    await updateMut.mutateAsync({
      id: selected.id,
      updates: {
        name: draft.name.trim() || selected.name,
        description: draft.description || null,
        tagline: draft.tagline || null,
        voiceGuide: draft.voiceGuide || null,
        doNot: draft.doNot
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        colorTokens: {
          primary: draft.primary || "#7C3AED",
          secondary: draft.secondary || undefined,
          accent: draft.accent || undefined,
        },
        fontStack: {
          display: draft.displayFont || undefined,
          body: draft.bodyFont || undefined,
          mono: draft.monoFont || undefined,
        },
        isDefault: draft.isDefault,
      },
    });
  }

  async function handleDelete() {
    if (!selected) return;
    if (!confirm(`Delete brand kit "${selected.name}"?`)) return;
    await deleteMut.mutateAsync(selected.id);
    setSelectedId(null);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-background px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Palette className="h-6 w-6 text-violet-500" />
              Brand Kit
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe your voice, palette, and fonts once. Any agent can opt
              in and produce on-brand output.
            </p>
          </div>
          <Button onClick={handleCreate} disabled={createMut.isPending}>
            {createMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            New brand kit
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-72 border-r bg-muted/30">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-2">
              {isLoading && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {error && (
                <p className="text-sm text-destructive">
                  {(error as Error).message}
                </p>
              )}
              {kits && kits.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No brand kits yet. Create one to get started.
                </p>
              )}
              {kits?.map((kit) => {
                const active = kit.id === selectedId;
                return (
                  <button
                    key={kit.id}
                    onClick={() => setSelectedId(kit.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      active
                        ? "border-violet-500 bg-violet-500/10"
                        : "border-transparent hover:bg-muted"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{kit.name}</span>
                      {kit.isDefault && (
                        <Badge
                          variant="secondary"
                          className="gap-1 text-[10px]"
                        >
                          <Star className="h-3 w-3" /> default
                        </Badge>
                      )}
                    </div>
                    {kit.tagline && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {kit.tagline}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        </aside>

        <main className="flex-1 overflow-hidden">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              Select or create a brand kit to begin editing.
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="mx-auto max-w-3xl space-y-4 p-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Identity</CardTitle>
                    <CardDescription>
                      Name, tagline, and the default marker.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="bk-name">Name</Label>
                      <Input
                        id="bk-name"
                        value={draft.name}
                        onChange={(e) => handleField("name", e.target.value)}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bk-description">Description</Label>
                      <Input
                        id="bk-description"
                        value={draft.description}
                        onChange={(e) =>
                          handleField("description", e.target.value)
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bk-tagline">Tagline</Label>
                      <Input
                        id="bk-tagline"
                        value={draft.tagline}
                        onChange={(e) => handleField("tagline", e.target.value)}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.isDefault}
                        onChange={(e) =>
                          handleField("isDefault", e.target.checked)
                        }
                      />
                      Use as default for new agents
                    </label>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Voice & tone</CardTitle>
                    <CardDescription>
                      Free-form markdown. Injected as the{" "}
                      <code>{"{{brandKit}}"}</code> block in agent system
                      prompts.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Textarea
                      rows={8}
                      value={draft.voiceGuide}
                      onChange={(e) =>
                        handleField("voiceGuide", e.target.value)
                      }
                      placeholder={
                        "Warm, confident, never salesy. Prefer concrete examples over jargon."
                      }
                    />
                    <div className="space-y-2">
                      <Label htmlFor="bk-donot">Do NOT (one rule per line)</Label>
                      <Textarea
                        id="bk-donot"
                        rows={4}
                        value={draft.doNot}
                        onChange={(e) => handleField("doNot", e.target.value)}
                        placeholder={
                          "Don't use exclamation points.\nNever mention competitors by name."
                        }
                      />
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Colors</CardTitle>
                    <CardDescription>
                      Hex values. Primary is required, others optional.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-3 gap-4">
                    {(["primary", "secondary", "accent"] as const).map(
                      (slot) => (
                        <div key={slot} className="space-y-2">
                          <Label htmlFor={`bk-${slot}`} className="capitalize">
                            {slot}
                          </Label>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={draft[slot] || "#000000"}
                              onChange={(e) =>
                                handleField(slot, e.target.value)
                              }
                              className="h-9 w-12 rounded border border-input"
                            />
                            <Input
                              id={`bk-${slot}`}
                              value={draft[slot]}
                              onChange={(e) =>
                                handleField(slot, e.target.value)
                              }
                              placeholder="#7C3AED"
                            />
                          </div>
                        </div>
                      ),
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Fonts</CardTitle>
                    <CardDescription>
                      CSS-style font family strings.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="bk-display">Display</Label>
                      <Input
                        id="bk-display"
                        value={draft.displayFont}
                        onChange={(e) =>
                          handleField("displayFont", e.target.value)
                        }
                        placeholder="Inter, sans-serif"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bk-body">Body</Label>
                      <Input
                        id="bk-body"
                        value={draft.bodyFont}
                        onChange={(e) =>
                          handleField("bodyFont", e.target.value)
                        }
                        placeholder="Inter, sans-serif"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="bk-mono">Mono</Label>
                      <Input
                        id="bk-mono"
                        value={draft.monoFont}
                        onChange={(e) =>
                          handleField("monoFont", e.target.value)
                        }
                        placeholder="JetBrains Mono, monospace"
                      />
                    </div>
                  </CardContent>
                </Card>

                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={handleDelete}
                    disabled={deleteMut.isPending}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={updateMut.isPending}
                  >
                    {updateMut.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    Save changes
                  </Button>
                </div>
              </div>
            </ScrollArea>
          )}
        </main>
      </div>
    </div>
  );
}
