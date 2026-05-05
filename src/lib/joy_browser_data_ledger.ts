/**
 * Joy Browser Data Ledger — local-first, user-owned browsing data.
 *
 * Philosophy: every site visit, every cookie, every minute of attention
 * is a data point that today belongs to ad networks. JoyCreate keeps
 * that data on the user's device and lets them choose to monetize it
 * (sell anonymized aggregates to model trainers, opt into paid
 * audience programs, etc.).
 *
 * This module is the *local ledger*. Monetization rails live elsewhere.
 *
 * Storage: localStorage (per-profile, never synced) under `joybrowser:`
 * keys. Switch to SQLite via IPC if/when the dataset grows.
 */

const LS_VISITS = "joybrowser:visits";
const LS_EARNINGS = "joybrowser:earnings";
const LS_CONSENT = "joybrowser:dataConsent";
const LS_PROGRAMS = "joybrowser:programs";

const MAX_VISITS = 5_000;

export interface VisitRecord {
  url: string;
  host: string;
  title: string;
  visitedAt: number;
  /** Approx milliseconds spent on the page (best-effort). */
  dwellMs?: number;
}

export interface EarningEntry {
  id: string;
  programId: string;
  amount: number; // in JOY tokens (display unit)
  reason: string;
  earnedAt: number;
  paid: boolean;
}

export interface DataConsent {
  /** Allow the user's anonymized browsing aggregates to be sold. */
  allowAggregateSales: boolean;
  /** Allow the user's reading time / scroll depth to be sold. */
  allowAttentionData: boolean;
  /** Allow JoyCreate to suggest ads based on local model inference only. */
  allowLocalAds: boolean;
  updatedAt: number;
}

export interface MonetizationProgram {
  id: string;
  name: string;
  description: string;
  payoutPerEvent: number; // JOY display units
  enabled: boolean;
}

const DEFAULT_PROGRAMS: MonetizationProgram[] = [
  {
    id: "ai-training-aggregate",
    name: "AI Training — Aggregate",
    description:
      "Sell anonymized topic-level aggregates of pages you've read to model trainers. Never includes URLs, hostnames, or content.",
    payoutPerEvent: 0.001,
    enabled: false,
  },
  {
    id: "trend-panel",
    name: "Trend Panel",
    description:
      "Contribute a hashed list of visited domains daily. Opt-in panels pay for trend data.",
    payoutPerEvent: 0.01,
    enabled: false,
  },
  {
    id: "attention-program",
    name: "Attention Program",
    description:
      "Share total daily reading time per topic category. Marketers pay for category-level attention.",
    payoutPerEvent: 0.005,
    enabled: false,
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or disabled */
  }
}

// ── visits ──────────────────────────────────────────────────────────────────

export function recordVisit(record: Omit<VisitRecord, "visitedAt">): void {
  const visits = getVisits();
  visits.push({ ...record, visitedAt: Date.now() });
  // Trim
  if (visits.length > MAX_VISITS) visits.splice(0, visits.length - MAX_VISITS);
  writeJSON(LS_VISITS, visits);
}

export function getVisits(): VisitRecord[] {
  return readJSON<VisitRecord[]>(LS_VISITS, []);
}

export function clearVisits(): void {
  localStorage.removeItem(LS_VISITS);
}

export interface DataStats {
  totalVisits: number;
  uniqueHosts: number;
  todayVisits: number;
  oldestVisitedAt: number | null;
}

export function getStats(): DataStats {
  const visits = getVisits();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const hosts = new Set<string>();
  let todayVisits = 0;
  let oldest: number | null = null;
  for (const v of visits) {
    hosts.add(v.host);
    if (v.visitedAt >= todayMs) todayVisits++;
    if (oldest === null || v.visitedAt < oldest) oldest = v.visitedAt;
  }
  return {
    totalVisits: visits.length,
    uniqueHosts: hosts.size,
    todayVisits,
    oldestVisitedAt: oldest,
  };
}

// ── earnings ────────────────────────────────────────────────────────────────

export function getEarnings(): EarningEntry[] {
  return readJSON<EarningEntry[]>(LS_EARNINGS, []);
}

export function addEarning(entry: Omit<EarningEntry, "id" | "earnedAt" | "paid">): EarningEntry {
  const e: EarningEntry = {
    ...entry,
    id: crypto.randomUUID(),
    earnedAt: Date.now(),
    paid: false,
  };
  const all = getEarnings();
  all.push(e);
  writeJSON(LS_EARNINGS, all);
  return e;
}

export function getEarningsTotal(): number {
  return getEarnings().reduce((acc, e) => acc + e.amount, 0);
}

export function getUnpaidTotal(): number {
  return getEarnings()
    .filter((e) => !e.paid)
    .reduce((acc, e) => acc + e.amount, 0);
}

// ── consent ─────────────────────────────────────────────────────────────────

export function getConsent(): DataConsent {
  return readJSON<DataConsent>(LS_CONSENT, {
    allowAggregateSales: false,
    allowAttentionData: false,
    allowLocalAds: false,
    updatedAt: 0,
  });
}

export function setConsent(c: Partial<Omit<DataConsent, "updatedAt">>): DataConsent {
  const next: DataConsent = { ...getConsent(), ...c, updatedAt: Date.now() };
  writeJSON(LS_CONSENT, next);
  return next;
}

// ── programs ────────────────────────────────────────────────────────────────

export function getPrograms(): MonetizationProgram[] {
  const stored = readJSON<MonetizationProgram[] | null>(LS_PROGRAMS, null);
  if (!stored) {
    writeJSON(LS_PROGRAMS, DEFAULT_PROGRAMS);
    return DEFAULT_PROGRAMS;
  }
  // Merge defaults so newly-added programs become available.
  const byId = new Map(stored.map((p) => [p.id, p]));
  for (const def of DEFAULT_PROGRAMS) {
    if (!byId.has(def.id)) byId.set(def.id, def);
  }
  const merged = Array.from(byId.values());
  writeJSON(LS_PROGRAMS, merged);
  return merged;
}

export function setProgramEnabled(id: string, enabled: boolean): MonetizationProgram[] {
  const all = getPrograms().map((p) => (p.id === id ? { ...p, enabled } : p));
  writeJSON(LS_PROGRAMS, all);
  return all;
}

/**
 * Simulate accruing earnings for an event. Real payouts would be settled by
 * a marketplace IPC handler; this just records the local credit so the user
 * can see the value being created.
 */
export function tickProgramEarnings(programId: string, eventCount = 1): EarningEntry | null {
  const program = getPrograms().find((p) => p.id === programId);
  if (!program?.enabled) return null;
  const consent = getConsent();
  // Gate by topic-specific consent flags.
  if (program.id === "attention-program" && !consent.allowAttentionData) return null;
  if (
    (program.id === "ai-training-aggregate" || program.id === "trend-panel") &&
    !consent.allowAggregateSales
  )
    return null;
  return addEarning({
    programId: program.id,
    amount: program.payoutPerEvent * eventCount,
    reason: `${program.name}: ${eventCount} event${eventCount === 1 ? "" : "s"}`,
  });
}
