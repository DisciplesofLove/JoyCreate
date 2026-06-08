/**
 * Calendar tab — a dependency-free month grid showing scheduled and posted
 * content, with quick navigation between months.
 */

import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { SocialPostDto } from "@/ipc/handlers/social_handlers";

import { useSocialPosts } from "@/hooks/useSocial";
import { POST_STATUS_LABEL, postStatusVariant } from "./shared";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}

function postTime(post: SocialPostDto): number | null {
  return post.scheduledFor ?? post.postedAt ?? null;
}

export function SocialCalendar() {
  const { data: posts, isLoading } = useSocialPosts({ limit: 500 });
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  const byDay = useMemo(() => {
    const map = new Map<string, SocialPostDto[]>();
    for (const post of posts ?? []) {
      const ts = postTime(post);
      if (!ts) continue;
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const list = map.get(key) ?? [];
      list.push(post);
      map.set(key, list);
    }
    return map;
  }, [posts]);

  const grid = useMemo(() => {
    const first = startOfMonth(cursor.year, cursor.month);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(
      cursor.year,
      cursor.month + 1,
      0,
    ).getDate();
    const cells: Array<{ day: number | null }> = [];
    for (let i = 0; i < startWeekday; i++) cells.push({ day: null });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d });
    while (cells.length % 7 !== 0) cells.push({ day: null });
    return cells;
  }, [cursor]);

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );
  const today = new Date();

  function shift(delta: number) {
    setCursor((c) => {
      const m = c.month + delta;
      const year = c.year + Math.floor(m / 12);
      const month = ((m % 12) + 12) % 12;
      return { year, month };
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{monthLabel}</CardTitle>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => shift(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setCursor({
                year: today.getFullYear(),
                month: today.getMonth(),
              })
            }
          >
            Today
          </Button>
          <Button size="icon" variant="ghost" onClick={() => shift(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border/40 bg-border/40">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="bg-muted/40 px-2 py-1.5 text-center text-xs font-medium text-muted-foreground"
            >
              {w}
            </div>
          ))}
          {grid.map((cell, i) => {
            if (cell.day === null) {
              return <div key={`empty-${i}`} className="min-h-[96px] bg-background/40" />;
            }
            const key = `${cursor.year}-${cursor.month}-${cell.day}`;
            const dayPosts = byDay.get(key) ?? [];
            const isToday =
              today.getFullYear() === cursor.year &&
              today.getMonth() === cursor.month &&
              today.getDate() === cell.day;
            return (
              <div
                key={key}
                className="min-h-[96px] bg-background/60 p-1.5"
              >
                <div
                  className={`mb-1 text-xs font-medium ${
                    isToday
                      ? "flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {cell.day}
                </div>
                <div className="space-y-1">
                  {dayPosts.slice(0, 3).map((post) => (
                    <div
                      key={post.id}
                      className="rounded bg-muted/50 px-1.5 py-1"
                      title={post.content.text}
                    >
                      <Badge
                        variant={postStatusVariant(post.status)}
                        className="mb-0.5 text-[9px]"
                      >
                        {POST_STATUS_LABEL[post.status]}
                      </Badge>
                      <p className="line-clamp-2 text-[10px] leading-tight text-foreground/80">
                        {post.content.text}
                      </p>
                    </div>
                  ))}
                  {dayPosts.length > 3 && (
                    <div className="text-[10px] text-muted-foreground">
                      +{dayPosts.length - 3} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
