/**
 * Boot reconciliation decides what happens to work that was in flight when the
 * process died. Getting it wrong is expensive in both directions: replay a run
 * whose steps are not idempotent and you send the same email or mint the same
 * asset twice; fail one that could have continued and the user silently loses
 * work they were told was queued.
 *
 * These tests pin the decision table.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { rows } = vi.hoisted(() => ({ rows: [] as any[] }));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

// A minimal stand-in for the activity table. The store itself is exercised
// against real Drizzle elsewhere; here we care about the supervisor's choices.
vi.mock("@/lib/runtime/activity_store", () => ({
  markOrphanedRunsInterrupted: () => {
    const orphans = rows.filter((r) => r.status === "running");
    orphans.forEach((r) => (r.status = "interrupted"));
    return [...orphans];
  },
  listResumable: () =>
    rows.filter((r) => r.status === "interrupted" && r.currentStepId != null),
  beginResume: (id: string, attempt: number) => {
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.status = "running";
      row.attempt = attempt;
    }
  },
  failActivity: (id: string, error: unknown) => {
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.status = "failed";
      row.errorMessage = error instanceof Error ? error.message : String(error);
    }
  },
  listStale: () => [],
  pruneCompleted: () => 0,
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => rows.filter((r) => r.status === "interrupted"),
        }),
      }),
    }),
  }),
}));

vi.mock("@/db/agent_os_schema", () => ({ osActivities: { id: "id", status: "status" } }));
vi.mock("drizzle-orm", () => ({ eq: () => undefined }));

import { reconcileRunsAtBoot, registerResumer } from "@/lib/runtime/supervisor";

function seed(...activities: any[]) {
  rows.length = 0;
  rows.push(...activities);
}

const running = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  source: "background",
  status: "running",
  currentStepId: "step-2",
  attempt: 0,
  ...over,
});

describe("boot reconciliation", () => {
  beforeEach(() => {
    rows.length = 0;
  });

  it("does nothing when there was no work in flight", async () => {
    seed({ id: "done", source: "background", status: "completed" });
    const out = await reconcileRunsAtBoot();
    expect(out).toEqual({ interrupted: 0, resumed: 0, failed: 0 });
  });

  it("resumes a run that recorded where it got to", async () => {
    seed(running());
    const resume = vi.fn(async () => undefined);
    registerResumer("background", resume);

    const out = await reconcileRunsAtBoot();

    expect(out.interrupted).toBe(1);
    expect(out.resumed).toBe(1);
    expect(resume).toHaveBeenCalledOnce();
    expect(rows[0].attempt).toBe(1);
  });

  it("refuses to replay a run with no resume point", async () => {
    // No cursor means we cannot know which side effects already happened.
    // Replaying from the start could repeat them, so it must fail instead.
    seed(running({ currentStepId: null }));
    registerResumer("background", vi.fn(async () => undefined));

    const out = await reconcileRunsAtBoot();

    expect(out.resumed).toBe(0);
    expect(out.failed).toBe(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toMatch(/no resume point/i);
  });

  it("fails a run whose source has no registered resumer", async () => {
    seed(running({ source: "a2a:invocation" }));
    const out = await reconcileRunsAtBoot();
    expect(out.failed).toBe(1);
    expect(rows[0].errorMessage).toMatch(/no resumer registered/i);
  });

  it("gives up on a run that has already been retried too often", async () => {
    // Otherwise a run that crashes the app on resume would crash it on every
    // subsequent boot too.
    seed(running({ attempt: 3 }));
    registerResumer("background", vi.fn(async () => undefined));

    const out = await reconcileRunsAtBoot();

    expect(out.resumed).toBe(0);
    expect(out.failed).toBe(1);
    expect(rows[0].errorMessage).toMatch(/gave up after/i);
  });

  it("fails the run rather than the boot when a resumer throws", async () => {
    seed(running());
    registerResumer("background", async () => {
      throw new Error("executor exploded");
    });

    const out = await reconcileRunsAtBoot();

    expect(out.failed).toBe(1);
    expect(rows[0].errorMessage).toBe("executor exploded");
  });

  it("keeps going after one run fails to resume", async () => {
    seed(
      running({ id: "bad" }),
      running({ id: "good", source: "mission" }),
    );
    registerResumer("background", async () => {
      throw new Error("nope");
    });
    const good = vi.fn(async () => undefined);
    registerResumer("mission", good);

    const out = await reconcileRunsAtBoot();

    expect(out.resumed).toBe(1);
    expect(out.failed).toBe(1);
    expect(good).toHaveBeenCalledOnce();
  });
});
