/**
 * PrivacyPanel — "Your data, your money" view for the Smart Browser.
 *
 * Shows:
 *   • Local browsing stats (visits, hosts, today)
 *   • Earnings ledger from opt-in monetization programs
 *   • Toggleable consent flags (default: everything OFF)
 *   • Toggleable monetization programs
 *   • Wipe-data button
 *
 * Everything is local. No server is contacted from this panel.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Shield,
  Trash2,
  TrendingUp,
  Globe,
  Eye,
  Coins,
  ToggleLeft,
  ToggleRight,
  Database,
} from "lucide-react";
import {
  clearVisits,
  getConsent,
  getEarnings,
  getEarningsTotal,
  getPrograms,
  getStats,
  getUnpaidTotal,
  setConsent,
  setProgramEnabled,
  type DataConsent,
  type EarningEntry,
  type MonetizationProgram,
} from "@/lib/joy_browser_data_ledger";

export function PrivacyPanel() {
  const [stats, setStats] = useState(() => getStats());
  const [consent, setConsentState] = useState<DataConsent>(() => getConsent());
  const [programs, setPrograms] = useState<MonetizationProgram[]>(() => getPrograms());
  const [earnings, setEarnings] = useState<EarningEntry[]>(() => getEarnings());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setStats(getStats());
    setEarnings(getEarnings());
  }, [tick]);

  // Refresh whenever the panel is shown.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  const total = getEarningsTotal();
  const unpaid = getUnpaidTotal();

  const toggleConsent = (k: keyof Omit<DataConsent, "updatedAt">) => {
    const next = setConsent({ [k]: !consent[k] });
    setConsentState(next);
  };

  const toggleProgram = (id: string, enabled: boolean) => {
    const next = setProgramEnabled(id, enabled);
    setPrograms(next);
  };

  const handleClearData = () => {
    if (!confirm("Wipe all local browsing history? Earnings and consent settings will be kept.")) return;
    clearVisits();
    setStats(getStats());
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border/50 flex items-center gap-2">
        <Shield className="h-4 w-4 text-emerald-500" />
        <span className="font-semibold text-sm">Your Data, Your Money</span>
      </div>

      <div className="overflow-y-auto p-3 space-y-3">
        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-2">
          <Stat icon={Eye} label="Pages" value={stats.totalVisits} />
          <Stat icon={Globe} label="Sites" value={stats.uniqueHosts} />
          <Stat icon={TrendingUp} label="Today" value={stats.todayVisits} />
        </div>

        {/* Earnings */}
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-2 mb-2">
            <Coins className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-xs font-medium">Earnings (local ledger)</span>
          </div>
          <div className="flex items-baseline gap-3">
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">Total</div>
              <div className="text-lg font-semibold tabular-nums">{total.toFixed(4)} JOY</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">Unpaid</div>
              <div className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {unpaid.toFixed(4)} JOY
              </div>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            JOY is the unit shown to you locally. Real settlement runs through the
            JoyMarketplace contract; opt-in programs accrue here until you cash out.
          </p>
        </div>

        {/* Consent */}
        <div className="rounded-md border border-border/50 p-3 space-y-2">
          <div className="text-xs font-medium flex items-center gap-2">
            <Shield className="h-3.5 w-3.5 text-violet-500" /> Data sharing
          </div>
          <ConsentRow
            label="Allow anonymized aggregate sales"
            desc="Topic-level aggregates only. No URLs, no hostnames, no content."
            on={consent.allowAggregateSales}
            onClick={() => toggleConsent("allowAggregateSales")}
          />
          <ConsentRow
            label="Allow attention-time data"
            desc="Total reading minutes per topic category, never per page."
            on={consent.allowAttentionData}
            onClick={() => toggleConsent("allowAttentionData")}
          />
          <ConsentRow
            label="Allow local-AI ad suggestions"
            desc="Suggestions are computed by your on-device model. Nothing leaves the machine."
            on={consent.allowLocalAds}
            onClick={() => toggleConsent("allowLocalAds")}
          />
        </div>

        {/* Programs */}
        <div className="rounded-md border border-border/50 p-3 space-y-2">
          <div className="text-xs font-medium flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-amber-500" /> Monetization programs
          </div>
          {programs.map((p) => (
            <div key={p.id} className="border border-border/40 rounded p-2 space-y-1">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => toggleProgram(p.id, !p.enabled)}
                  className="shrink-0"
                  aria-label={p.enabled ? "Disable" : "Enable"}
                >
                  {p.enabled ? (
                    <ToggleRight className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium">{p.name}</div>
                  <div className="text-[10px] text-muted-foreground">{p.description}</div>
                </div>
                <div className="text-[10px] text-muted-foreground tabular-nums">
                  {p.payoutPerEvent} JOY / event
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Recent earnings */}
        {earnings.length > 0 && (
          <div className="rounded-md border border-border/50 p-3 space-y-1">
            <div className="text-xs font-medium mb-1">Recent earnings</div>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {[...earnings].reverse().slice(0, 30).map((e) => (
                <div key={e.id} className="text-[11px] flex justify-between gap-2">
                  <span className="truncate text-muted-foreground">{e.reason}</span>
                  <span className="tabular-nums shrink-0">+{e.amount.toFixed(4)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Wipe */}
        <Button variant="outline" size="sm" className="w-full gap-2" onClick={handleClearData}>
          <Trash2 className="h-3.5 w-3.5 text-red-500" /> Wipe browsing history
        </Button>
        <p className="text-[10px] text-muted-foreground text-center">
          History lives in your browser only — no JoyCreate server ever sees it.
        </p>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 px-2 py-2 flex flex-col items-center gap-1">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}

function ConsentRow({
  label,
  desc,
  on,
  onClick,
}: {
  label: string;
  desc: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-2 px-1 py-1 rounded hover:bg-muted/40 transition-colors"
    >
      {on ? (
        <ToggleRight className="h-5 w-5 text-emerald-500 shrink-0" />
      ) : (
        <ToggleLeft className="h-5 w-5 text-muted-foreground shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs">{label}</div>
        <div className="text-[10px] text-muted-foreground">{desc}</div>
      </div>
    </button>
  );
}
