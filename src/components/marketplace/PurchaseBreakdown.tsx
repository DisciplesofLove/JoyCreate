/**
 * "Where the price goes" — buyer-facing revenue split breakdown.
 *
 * Mirrors the on-chain RevenueSplitter math exactly (integer bps on 6dp USDC
 * atomic units, remainder → Compute) so the displayed amounts always equal
 * the settled `RevenueSplit` event amounts. See docs/payments/.
 */

import { Badge } from "@/components/ui/badge";
import type { X402Status } from "@/ipc/ipc_client";

const USDC_DECIMALS = 6n;
const ATOMIC_BASE = 10n ** USDC_DECIMALS;

function usdcToAtomic(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "000000").slice(0, Number(USDC_DECIMALS));
  return BigInt(whole || "0") * ATOMIC_BASE + BigInt(fracPadded || "0");
}

function formatUsdc(atomic: bigint): string {
  const whole = atomic / ATOMIC_BASE;
  const frac = (atomic % ATOMIC_BASE).toString().padStart(6, "0").replace(/0+$/, "");
  const fracDisplay = frac.length < 2 ? frac.padEnd(2, "0") : frac;
  return `$${whole}.${fracDisplay} USDC`;
}

interface SplitRow {
  label: string;
  pct: string;
  amount: bigint;
}

export function PurchaseBreakdown({
  priceUsdc,
  status,
}: {
  /** Human-readable USDC price, e.g. "3" or "3.00". */
  priceUsdc: string;
  /** From useX402Status; undefined while loading. */
  status: X402Status | undefined;
}) {
  const bps = status?.splitBps ?? { creator: 8000, platform: 1000, protocol: 1000 };
  const amount = usdcToAtomic(priceUsdc);
  const seller = (amount * BigInt(bps.creator)) / 10000n;
  const platformDao = (amount * BigInt(bps.platform)) / 10000n;
  const compute = amount - seller - platformDao; // remainder → Compute, like the contract

  const rows: SplitRow[] = [
    { label: "Seller", pct: `${bps.creator / 100}%`, amount: seller },
    { label: "Compute", pct: `${bps.protocol / 100}%`, amount: compute },
    { label: "Platform + DAO", pct: `${bps.platform / 100}%`, amount: platformDao },
  ];

  const live = status?.ready === true;

  return (
    <div className="rounded-lg border p-4 space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Where the price goes</span>
        {live ? (
          <Badge variant="secondary">Split enforced on-chain</Badge>
        ) : (
          <Badge variant="outline">Preview</Badge>
        )}
      </div>
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {row.label} ({row.pct})
          </span>
          <span className="font-mono">{formatUsdc(row.amount)}</span>
        </div>
      ))}
      {live ? (
        <p className="text-xs text-muted-foreground pt-1">
          Distributed atomically by the RevenueSplitter contract in the
          settlement transaction.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground pt-1">
          Preview only — the on-chain split contract isn't deployed on this
          network, so this purchase currently settles in full to the store's
          configured payout address.
        </p>
      )}
    </div>
  );
}
