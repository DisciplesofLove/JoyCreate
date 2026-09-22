/**
 * Escrow is the only place in JoyCreate where an agent's balance moves without
 * a person watching, so the failure paths matter more than the happy one.
 *
 * Three bugs these tests exist to keep fixed:
 *
 *   1. A failed invocation left the caller debited and the provider unpaid.
 *      Settlement only ever ran on the verified path, so money that entered
 *      escrow via a job that threw stayed there — counted against the caller's
 *      daily cap until the UTC day rolled over, and against a spend-limit
 *      policy indefinitely.
 *   2. Once failure refunded automatically, an operator calling refund by hand
 *      afterwards would have credited the caller a second time.
 *   3. A contract left `IN_PROGRESS` by a killed process could never advance,
 *      because the executor that owned it no longer existed.
 *
 * The fake below is a real store, not a stub: rows are mutated and read back,
 * so a refund that credits twice actually shows up as a doubled balance rather
 * than as an extra call on a spy.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

interface Row {
  [k: string]: any;
}

/** Predicate tree produced by the mocked drizzle operators. */
type Pred = (row: Row) => boolean;

// Everything the mock factories touch has to live inside `vi.hoisted`, because
// `vi.mock` calls are lifted above the file's own declarations.
const { tables, db, col } = vi.hoisted(() => {
  const tables: Record<string, any[]> = {
    a2a_contracts: [],
    a2a_invocations: [],
    rewards_ledger: [],
    agent_principals: [],
  };

  /** Column marker: the mocked schema exposes columns as {__t, __c} pairs. */
  const col = (t: string, c: string) => ({ __t: t, __c: c });

  const tableOf = (marker: any): any[] => tables[marker.__table];

  /**
   * Minimal drizzle surface: select/insert/update, thenable so `await` on the
   * builder resolves to rows the way the real query builder does.
   */
  const db = {
    select(_cols?: any) {
      return {
        from(t: any) {
          const rows = tableOf(t);
          const build = (pred?: any) => {
            const result = () => (pred ? rows.filter(pred) : [...rows]);
            const api: any = {
              where: (p?: any) => build(p),
              orderBy: () => api,
              limit: (n: number) => result().slice(0, n),
              then: (res: any, rej: any) =>
                Promise.resolve(result()).then(res, rej),
              [Symbol.iterator]: () => result()[Symbol.iterator](),
            };
            return api;
          };
          return build();
        },
      };
    },
    insert(t: any) {
      return {
        values: async (v: any) => {
          tableOf(t).push({ ...v });
        },
      };
    },
    update(t: any) {
      return {
        set(patch: any) {
          return {
            where: async (pred: any) => {
              for (const row of tableOf(t)) {
                if (pred(row)) Object.assign(row, patch);
              }
            },
          };
        },
      };
    },
  };

  return { tables, db, col };
});

vi.mock("drizzle-orm", () => ({
  eq: (a: any, b: any): Pred => (row) => row[a.__c] === b,
  gt: (a: any, b: any): Pred => (row) => row[a.__c] > b,
  lt: (a: any, b: any): Pred => (row) => row[a.__c] < b,
  and:
    (...ps: Pred[]): Pred =>
    (row) => ps.every((p) => !p || p(row)),
  or:
    (...ps: Pred[]): Pred =>
    (row) => ps.some((p) => p && p(row)),
  desc: () => undefined,
  inArray: (a: any, vals: any[]): Pred => (row) => vals.includes(row[a.__c]),
  sql: Object.assign(() => undefined, { raw: () => undefined }),
}));

vi.mock("@/db", () => ({ db, getDb: () => db }));

vi.mock("@/db/a2a_schema", () => ({
  a2aContracts: {
    __table: "a2a_contracts",
    id: col("a2a_contracts", "id"),
    state: col("a2a_contracts", "state"),
    callerPrincipalId: col("a2a_contracts", "callerPrincipalId"),
    createdAt: col("a2a_contracts", "createdAt"),
  },
  a2aInvocations: {
    __table: "a2a_invocations",
    id: col("a2a_invocations", "id"),
    status: col("a2a_invocations", "status"),
    contractId: col("a2a_invocations", "contractId"),
  },
  a2aQuotes: { __table: "a2a_quotes", id: col("a2a_quotes", "id") },
  agentPrincipals: {
    __table: "agent_principals",
    id: col("agent_principals", "id"),
  },
  agentServiceListings: {
    __table: "agent_service_listings",
    id: col("agent_service_listings", "id"),
  },
}));

vi.mock("@/db/schema", () => ({
  rewardsLedger: {
    __table: "rewards_ledger",
    id: col("rewards_ledger", "id"),
    status: col("rewards_ledger", "status"),
  },
  agents: { __table: "agents", id: col("agents", "id") },
  ssiIdentities: { __table: "ssi_identities", id: col("ssi_identities", "id") },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    }),
  },
}));

// Provenance, DID and Celestia calls are all wrapped in `safeEmit` in the
// engine; stubbing them keeps a failure in one of them from being mistaken for
// a failure in the escrow logic under test.
vi.mock("@/lib/agent_provenance", () => ({
  emitEvent: async () => undefined,
  recomputeScore: async () => undefined,
}));
vi.mock("@/lib/ssi/did_document_service", () => ({
  didDocumentService: { createDidDocument: async () => ({ did: "did:test" }) },
}));
vi.mock("@/lib/celestia_blob_service", () => ({
  celestiaBlobService: { submitBlob: async () => ({ height: 1 }) },
}));
vi.mock("@/lib/agent_os", () => ({
  startActivity: async () => ({ id: "act-1" }),
  completeActivity: async () => undefined,
  failActivity: async () => undefined,
}));

import {
  failContract,
  refundContract,
  reconcileStrandedContracts,
  getContract,
} from "@/lib/a2a_economy";

const CALLER = "principal-caller";
const PROVIDER = "principal-provider";

function seedContract(over: Row = {}): string {
  const id = over.id ?? "contract-1";
  tables.rewards_ledger.push({
    id: "ledger-1",
    status: "pending",
    amount: "100",
  });
  tables.a2a_contracts.push({
    id,
    quoteId: "quote-1",
    listingId: "listing-1",
    callerPrincipalId: CALLER,
    providerPrincipalId: PROVIDER,
    state: "IN_PROGRESS",
    stateHistoryJson: [],
    amount: "100",
    currency: "USDC",
    escrowLedgerId: "ledger-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
  return id;
}

function seedPrincipals(spentToday = "100") {
  tables.agent_principals.push(
    {
      id: CALLER,
      did: "did:joy:caller",
      status: "active",
      currency: "USDC",
      dailyCap: "1000",
      perTaskCap: "500",
      spentTodayString: spentToday,
      spentTodayResetAt: new Date(),
    },
    {
      id: PROVIDER,
      did: "did:joy:provider",
      status: "active",
      currency: "USDC",
      dailyCap: "0",
      perTaskCap: "0",
      spentTodayString: "0",
      spentTodayResetAt: new Date(),
    },
  );
}

const callerSpend = () =>
  tables.agent_principals.find((p) => p.id === CALLER)!.spentTodayString;

const escrowStatus = () =>
  tables.rewards_ledger.find((r) => r.id === "ledger-1")!.status;

beforeEach(() => {
  for (const key of Object.keys(tables)) tables[key].length = 0;
});

describe("escrow release on failure", () => {
  it("returns the caller's money when the work fails", async () => {
    seedPrincipals("100");
    const id = seedContract();

    await failContract(id, "executor exploded");

    // The debit taken at escrow is given back, and the escrow row is closed.
    expect(callerSpend()).toBe("0");
    expect(escrowStatus()).toBe("expired");
  });

  it("records the failure reason even though it ends up refunded", async () => {
    seedPrincipals("100");
    const id = seedContract();

    await failContract(id, "provider timed out");

    const contract = await getContract(id);
    expect(contract.state).toBe("REFUNDED");
    expect(contract.failureReason).toBe("provider timed out");
    // Both hops are on the record, so "why did this refund" is answerable.
    const states = contract.stateHistoryJson.map((h: any) => h.state ?? h.to);
    expect(states).toContain("FAILED");
    expect(states).toContain("REFUNDED");
  });

  it("does not credit twice when refund is called after an auto-refund", async () => {
    seedPrincipals("100");
    const id = seedContract();

    await failContract(id, "executor exploded");
    await refundContract(id, "operator retry");

    // A second credit here would hand the agent 100 units of free budget.
    expect(callerSpend()).toBe("0");
  });

  it("refunds a contract that never ran, from ESCROWED", async () => {
    seedPrincipals("100");
    const id = seedContract({ state: "ESCROWED" });

    await refundContract(id, "buyer changed their mind");

    expect(callerSpend()).toBe("0");
    expect((await getContract(id)).state).toBe("REFUNDED");
  });

  it("leaves a contract with no escrow alone", async () => {
    seedPrincipals("0");
    const id = seedContract({ state: "ACCEPTED", escrowLedgerId: null });

    await failContract(id, "rejected before escrow");

    // Nothing was ever debited, so nothing is credited — the counter must not
    // drift negative or clamp its way to a wrong value.
    expect(callerSpend()).toBe("0");
    expect((await getContract(id)).state).toBe("FAILED");
  });
});

describe("boot reconciliation of stranded contracts", () => {
  it("refunds work that was mid-execution when the process died", async () => {
    seedPrincipals("100");
    const id = seedContract({ state: "IN_PROGRESS" });
    tables.a2a_invocations.push({
      id: "inv-1",
      contractId: id,
      status: "running",
    });

    const out = await reconcileStrandedContracts();

    expect(out.contracts).toBe(1);
    expect(out.invocations).toBe(1);
    expect(callerSpend()).toBe("0");
    expect(tables.a2a_invocations[0].status).toBe("failed");
    expect((await getContract(id)).state).toBe("REFUNDED");
  });

  it("leaves escrowed-but-not-started work for the caller to invoke", async () => {
    // ESCROWED is a legitimate resting state — the buyer has paid and has not
    // asked for the work yet. Sweeping it would refund contracts nobody
    // abandoned.
    seedPrincipals("100");
    seedContract({ state: "ESCROWED" });

    const out = await reconcileStrandedContracts();

    expect(out.contracts).toBe(0);
    expect(callerSpend()).toBe("100");
  });

  it("reports nothing to do on a clean boot", async () => {
    seedPrincipals("0");
    const out = await reconcileStrandedContracts();
    expect(out).toEqual({ contracts: 0, invocations: 0 });
  });
});
