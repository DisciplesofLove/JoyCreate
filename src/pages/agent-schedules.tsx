/**
 * Agent Schedules page.
 *
 * Create and manage recurring runs for any agent. Supports interval, daily,
 * and weekly triggers. Tracks history of each fired run.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Calendar,
  Clock,
  Loader2,
  Play,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Repeat,
  Sparkles,
  Volume2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  useAgentSchedules,
  useAgentScheduleHistory,
  useCreateAgentSchedule,
  useDeleteAgentSchedule,
  useToggleAgentSchedule,
  useRunAgentScheduleNow,
  type AgentSchedule,
  type ScheduleTrigger,
} from "@/hooks/useAgentSchedules";
import { agentBuilderClient } from "@/ipc/agent_builder_client";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showSuccess } from "@/lib/toast";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function describeTrigger(t: ScheduleTrigger): string {
  if (t.type === "interval") {
    if (t.everyMinutes % 60 === 0) {
      const h = t.everyMinutes / 60;
      return `Every ${h} hour${h === 1 ? "" : "s"}`;
    }
    return `Every ${t.everyMinutes} min`;
  }
  if (t.type === "daily") {
    return `Daily at ${pad(t.atHour)}:${pad(t.atMinute)}`;
  }
  return `Weekly · ${WEEKDAYS[t.weekday]} ${pad(t.atHour)}:${pad(t.atMinute)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  const absMin = Math.round(Math.abs(diff) / 60_000);
  if (diff > 0) {
    if (absMin < 1) return "in <1m";
    if (absMin < 60) return `in ${absMin}m`;
    if (absMin < 60 * 24) return `in ${Math.round(absMin / 60)}h`;
    return `in ${Math.round(absMin / (60 * 24))}d`;
  }
  if (absMin < 1) return "just now";
  if (absMin < 60) return `${absMin}m ago`;
  if (absMin < 60 * 24) return `${Math.round(absMin / 60)}h ago`;
  return `${Math.round(absMin / (60 * 24))}d ago`;
}

interface CreateForm {
  agentId: string;
  name: string;
  brief: string;
  triggerType: "interval" | "daily" | "weekly";
  everyMinutes: number;
  atHour: number;
  atMinute: number;
  weekday: number;
  enabled: boolean;
  ttsEnabled: boolean;
  ttsVoice: string;
  notifyJoyAssistant: boolean;
  notifyOpenClawClientId: string;
  notifyOpenClawChannelId: string;
}

const defaultForm: CreateForm = {
  agentId: "",
  name: "",
  brief: "",
  triggerType: "daily",
  everyMinutes: 60,
  atHour: 8,
  atMinute: 0,
  weekday: 1,
  enabled: true,
  ttsEnabled: false,
  ttsVoice: "",
  notifyJoyAssistant: false,
  notifyOpenClawClientId: "",
  notifyOpenClawChannelId: "",
};

export default function AgentSchedulesPage() {
  const schedulesQuery = useAgentSchedules();
  const historyQuery = useAgentScheduleHistory(undefined, 50);
  const createMutation = useCreateAgentSchedule();
  const deleteMutation = useDeleteAgentSchedule();
  const toggleMutation = useToggleAgentSchedule();
  const runNowMutation = useRunAgentScheduleNow();

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => agentBuilderClient.listAgents(),
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateForm>(defaultForm);
  const [audioByPath, setAudioByPath] = useState<Record<string, string>>({});
  const [loadingAudio, setLoadingAudio] = useState<string | null>(null);

  const handleLoadAudio = async (audioPath: string) => {
    if (audioByPath[audioPath]) return;
    setLoadingAudio(audioPath);
    try {
      const res = await IpcClient.getInstance().readAgentScheduleAudio(audioPath);
      setAudioByPath((prev) => ({ ...prev, [audioPath]: res.dataUrl }));
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to load audio");
    } finally {
      setLoadingAudio(null);
    }
  };

  const agents = agentsQuery.data ?? [];
  const schedules = schedulesQuery.data ?? [];
  const history = historyQuery.data ?? [];

  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) m.set(a.id, a.name);
    return m;
  }, [agents]);

  const reset = () => {
    setForm(defaultForm);
    setOpen(false);
  };

  const handleCreate = async () => {
    if (!form.agentId) {
      showError("Pick an agent");
      return;
    }
    if (!form.name.trim()) {
      showError("Name is required");
      return;
    }
    if (!form.brief.trim()) {
      showError("Brief is required");
      return;
    }
    let trigger: ScheduleTrigger;
    if (form.triggerType === "interval") {
      trigger = { type: "interval", everyMinutes: form.everyMinutes };
    } else if (form.triggerType === "daily") {
      trigger = { type: "daily", atHour: form.atHour, atMinute: form.atMinute };
    } else {
      trigger = {
        type: "weekly",
        weekday: form.weekday,
        atHour: form.atHour,
        atMinute: form.atMinute,
      };
    }
    try {
      await createMutation.mutateAsync({
        agentId: form.agentId,
        name: form.name.trim(),
        brief: form.brief.trim(),
        trigger,
        enabled: form.enabled,
        tts: form.ttsEnabled
          ? {
              enabled: true,
              voice: form.ttsVoice.trim() || undefined,
            }
          : undefined,
        notifications:
          form.notifyJoyAssistant ||
          (form.notifyOpenClawClientId.trim() &&
            form.notifyOpenClawChannelId.trim())
            ? {
                joyAssistant: form.notifyJoyAssistant || undefined,
                openclaw:
                  form.notifyOpenClawClientId.trim() &&
                  form.notifyOpenClawChannelId.trim()
                    ? {
                        clientId: form.notifyOpenClawClientId.trim(),
                        channelId: form.notifyOpenClawChannelId.trim(),
                      }
                    : undefined,
              }
            : undefined,
      });
      showSuccess("Schedule created");
      reset();
    } catch (err) {
      showError(
        err instanceof Error ? err.message : "Failed to create schedule",
      );
    }
  };

  const handleDelete = async (s: AgentSchedule) => {
    if (
      !window.confirm(`Delete schedule "${s.name}"? This cannot be undone.`)
    ) {
      return;
    }
    try {
      await deleteMutation.mutateAsync(s.id);
      showSuccess("Schedule deleted");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const handleToggle = async (s: AgentSchedule, enabled: boolean) => {
    try {
      await toggleMutation.mutateAsync({ id: s.id, enabled });
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to toggle");
    }
  };

  const handleRunNow = async (s: AgentSchedule) => {
    try {
      await runNowMutation.mutateAsync(s.id);
      historyQuery.refetch();
      showSuccess("Triggered run");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to trigger");
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Calendar className="h-7 w-7 text-violet-500" />
            Agent Schedules
          </h1>
          <p className="text-muted-foreground mt-1">
            Recurring runs for your agents. Daily briefings, weekly digests,
            or interval polling.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> New schedule
        </Button>
      </div>

      {/* Schedules grid */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Active schedules</h2>
        {schedulesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : schedules.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center text-muted-foreground">
              <Calendar className="h-10 w-10 mx-auto mb-3 opacity-40" />
              No schedules yet. Click "New schedule" to set up your first
              recurring run.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {schedules.map((s) => (
              <Card key={s.id} className="border-border/50">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{s.name}</CardTitle>
                    <Switch
                      checked={s.enabled}
                      onCheckedChange={(v) => handleToggle(s, v)}
                      disabled={toggleMutation.isPending}
                    />
                  </div>
                  <CardDescription className="line-clamp-2">
                    {s.brief}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                    <span className="text-muted-foreground">Agent:</span>
                    <span className="truncate">
                      {agentNameById.get(s.agentId) ?? s.agentId}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Repeat className="h-3.5 w-3.5 text-sky-500" />
                    <span className="text-muted-foreground">Trigger:</span>
                    <Badge variant="outline">{describeTrigger(s.trigger)}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-muted-foreground">Next run:</span>
                    <span>{relativeTime(s.nextRunAt)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.lastRunStatus === "completed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : s.lastRunStatus === "failed" ? (
                      <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className="text-muted-foreground">Last run:</span>
                    <span>{relativeTime(s.lastRunAt)}</span>
                  </div>
                </CardContent>
                <CardFooter className="gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRunNow(s)}
                    disabled={runNowMutation.isPending}
                  >
                    {runNowMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <Play className="h-3.5 w-3.5 mr-1" />
                    )}
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rose-500 hover:text-rose-600 ml-auto"
                    onClick={() => handleDelete(s)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* History */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Recent runs</h2>
        <Card className="border-border/50">
          <ScrollArea className="max-h-96">
            <div className="divide-y">
              {historyQuery.isLoading ? (
                <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading
                  history...
                </div>
              ) : history.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground text-center">
                  No runs yet. Trigger one manually or wait for the next
                  scheduled run.
                </div>
              ) : (
                history.map((h) => {
                  const sched = schedules.find((s) => s.id === h.scheduleId);
                  return (
                    <div key={h.id} className="p-3 text-sm space-y-1">
                      <div className="flex items-center gap-2">
                        {h.status === "completed" ? (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
                        )}
                        <span className="font-medium">
                          {sched?.name ?? h.scheduleId}
                        </span>
                        <Badge variant="outline" className="ml-auto">
                          {new Date(h.startedAt).toLocaleString()}
                        </Badge>
                      </div>
                      {h.status === "completed" ? (
                        <p className="text-xs text-muted-foreground line-clamp-2 pl-5">
                          {h.outputPreview || "(empty output)"}
                        </p>
                      ) : (
                        <p className="text-xs text-rose-500 line-clamp-2 pl-5">
                          {h.error || "Unknown error"}
                        </p>
                      )}
                      {h.audioPath && (
                        <div className="pl-5 pt-1">
                          {audioByPath[h.audioPath] ? (
                            <audio
                              controls
                              src={audioByPath[h.audioPath]}
                              className="h-8 w-full max-w-md"
                            />
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleLoadAudio(h.audioPath!)}
                              disabled={loadingAudio === h.audioPath}
                            >
                              {loadingAudio === h.audioPath ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                              ) : (
                                <Volume2 className="h-3.5 w-3.5 mr-1" />
                              )}
                              Play audio briefing
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </Card>
      </section>

      {/* Create dialog */}
      <Dialog open={open} onOpenChange={(o) => !o && reset()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New schedule</DialogTitle>
            <DialogDescription>
              Run an agent automatically on a recurring trigger.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>Agent</Label>
              <Select
                value={form.agentId}
                onValueChange={(v) => setForm({ ...form, agentId: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick an agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.length === 0 ? (
                    <SelectItem value="" disabled>
                      No agents yet — create one from the Agent Gallery
                    </SelectItem>
                  ) : (
                    agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="sched-name">Name</Label>
              <Input
                id="sched-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Morning briefing"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="sched-brief">Brief</Label>
              <Textarea
                id="sched-brief"
                value={form.brief}
                onChange={(e) => setForm({ ...form, brief: e.target.value })}
                rows={3}
                placeholder="What should the agent do on each run?"
              />
            </div>

            <div className="grid gap-2">
              <Label>Trigger</Label>
              <Select
                value={form.triggerType}
                onValueChange={(v) =>
                  setForm({ ...form, triggerType: v as CreateForm["triggerType"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="interval">Interval</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.triggerType === "interval" && (
              <div className="grid gap-2">
                <Label htmlFor="sched-interval">Every (minutes)</Label>
                <Input
                  id="sched-interval"
                  type="number"
                  min={1}
                  value={form.everyMinutes}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      everyMinutes: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                />
              </div>
            )}

            {(form.triggerType === "daily" || form.triggerType === "weekly") && (
              <div className="grid grid-cols-2 gap-3">
                {form.triggerType === "weekly" && (
                  <div className="grid gap-2 col-span-2">
                    <Label>Day of week</Label>
                    <Select
                      value={String(form.weekday)}
                      onValueChange={(v) =>
                        setForm({ ...form, weekday: Number(v) })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((d, i) => (
                          <SelectItem key={d} value={String(i)}>
                            {d}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="grid gap-2">
                  <Label htmlFor="sched-hour">Hour (0-23)</Label>
                  <Input
                    id="sched-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={form.atHour}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        atHour: Math.max(
                          0,
                          Math.min(23, Number(e.target.value) || 0),
                        ),
                      })
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="sched-min">Minute (0-59)</Label>
                  <Input
                    id="sched-min"
                    type="number"
                    min={0}
                    max={59}
                    value={form.atMinute}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        atMinute: Math.max(
                          0,
                          Math.min(59, Number(e.target.value) || 0),
                        ),
                      })
                    }
                  />
                </div>
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              />
              Enabled
            </label>

            <div className="rounded-md border border-border/50 p-3 space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.ttsEnabled}
                  onCheckedChange={(v) => setForm({ ...form, ttsEnabled: v })}
                />
                <Volume2 className="h-4 w-4 text-violet-500" />
                Generate audio briefing (TTS)
              </label>
              {form.ttsEnabled && (
                <div className="grid gap-2">
                  <Label htmlFor="sched-voice">Voice (optional)</Label>
                  <Input
                    id="sched-voice"
                    value={form.ttsVoice}
                    onChange={(e) =>
                      setForm({ ...form, ttsVoice: e.target.value })
                    }
                    placeholder="e.g. ElevenLabs voice ID or leave blank"
                  />
                  <p className="text-xs text-muted-foreground">
                    Each successful run produces a playable audio file you
                    can listen to from the Recent runs panel.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-md border border-border/50 p-3 space-y-3">
              <div className="text-sm font-medium">Notifications</div>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.notifyJoyAssistant}
                  onCheckedChange={(v) =>
                    setForm({ ...form, notifyJoyAssistant: v })
                  }
                />
                Notify Joy Assistant when this schedule runs
              </label>
              <div className="grid gap-2">
                <Label htmlFor="sched-oc-client">
                  Broadcast to OpenClaw (optional)
                </Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    id="sched-oc-client"
                    value={form.notifyOpenClawClientId}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        notifyOpenClawClientId: e.target.value,
                      })
                    }
                    placeholder="clientId (e.g. discord-bot)"
                  />
                  <Input
                    value={form.notifyOpenClawChannelId}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        notifyOpenClawChannelId: e.target.value,
                      })
                    }
                    placeholder="channelId"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Fill in both to broadcast each run summary back to a
                  connected OpenClaw client / channel (Discord, Telegram,
                  etc.).
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={reset}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
