/**
 * Shared constants + small helpers for the social suite UI.
 */

import type {
  SocialPostStatus,
  SocialProvider,
} from "@/db/social_schema";

export const PROVIDER_LABEL: Record<SocialProvider, string> = {
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  reddit: "Reddit",
};

export const PROVIDER_ORDER: SocialProvider[] = [
  "reddit",
  "twitter",
  "linkedin",
  "facebook",
  "instagram",
];

/** Single-letter glyph badge color per provider. */
export const PROVIDER_ACCENT: Record<SocialProvider, string> = {
  twitter: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  linkedin: "bg-blue-600/15 text-blue-400 border-blue-600/30",
  instagram: "bg-pink-500/15 text-pink-400 border-pink-500/30",
  facebook: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
  reddit: "bg-orange-500/15 text-orange-400 border-orange-500/30",
};

export function providerInitial(provider: SocialProvider): string {
  return PROVIDER_LABEL[provider]?.charAt(0).toUpperCase() ?? "?";
}

export const POST_STATUS_LABEL: Record<SocialPostStatus, string> = {
  draft: "Draft",
  needs_approval: "Needs approval",
  scheduled: "Scheduled",
  publishing: "Publishing",
  posted: "Posted",
  partially_posted: "Partially posted",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function postStatusVariant(
  status: SocialPostStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "posted":
      return "default";
    case "failed":
    case "cancelled":
      return "destructive";
    case "needs_approval":
    case "scheduled":
    case "publishing":
    case "partially_posted":
      return "secondary";
    default:
      return "outline";
  }
}

export function fmtTs(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export function fmtRelative(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const unit = mins < 60 ? `${mins}m` : hours < 48 ? `${hours}h` : `${days}d`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** Local datetime string for an <input type="datetime-local">. */
export function toLocalDatetimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function fromLocalDatetimeInput(value: string): number | null {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}
