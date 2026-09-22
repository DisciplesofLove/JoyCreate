/**
 * Channel ownership is what stops JoyCreate becoming a second poller on a token
 * something else already owns.
 *
 * This is not hypothetical. The OpenClaw daemon's own error log records the
 * failure:
 *
 *   409: Conflict: terminated by other getUpdates request; make sure that only
 *   one bot instance is running.
 *
 * Telegram allows exactly one `getUpdates` poller per token. When two run, both
 * lose messages, and the symptom — mail arriving erratically or not at all — is
 * nowhere near the cause. Someone had already disabled Telegram in the daemon
 * config to escape it.
 *
 * The decision table below is therefore the safety property of this feature,
 * which is why it is tested directly rather than only through a running bot.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    daemonAlive: false,
    daemonProbeThrows: false,
    daemonConfig: null as unknown,
    configReadThrows: false,
    telegramOwner: undefined as "local" | "daemon" | undefined,
    settingsThrow: false,
  },
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock("electron", () => ({
  app: { getPath: () => "C:/home" },
}));

vi.mock("@/main/settings", () => ({
  readSettings: () => {
    if (state.settingsThrow) throw new Error("settings unreadable");
    return { telegramOwner: state.telegramOwner };
  },
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: () => {
      if (state.configReadThrows) throw new Error("ENOENT");
      return JSON.stringify(state.daemonConfig);
    },
  },
}));

vi.mock("@/lib/openclaw_gateway_service", () => ({
  getOpenClawGateway: () => ({
    isDaemonAlive: async () => {
      if (state.daemonProbeThrows) throw new Error("probe exploded");
      return state.daemonAlive;
    },
  }),
}));

import {
  assertMayStart,
  readDaemonChannel,
  resolveOwner,
} from "@/lib/channels/channel_owner";

beforeEach(() => {
  state.daemonAlive = false;
  state.daemonProbeThrows = false;
  state.configReadThrows = false;
  // "daemon" unless a test says otherwise, so the daemon-precedence cases can
  // be expressed with Telegram like the rest.
  state.telegramOwner = "daemon";
  state.settingsThrow = false;
  state.daemonConfig = { channels: {} };
});

/** Shape the daemon's config file the way the real one looks. */
function daemonOwns(channel: string, over: Record<string, unknown> = {}) {
  state.daemonAlive = true;
  state.daemonConfig = {
    channels: {
      [channel]: { enabled: true, token: "daemon-token", botToken: "daemon-token", ...over },
    },
  };
}

describe("reading the daemon's claim", () => {
  it("reports a configured, enabled channel", () => {
    state.daemonConfig = {
      channels: { discord: { enabled: true, token: "abc" } },
    };
    expect(readDaemonChannel("discord")).toEqual({
      enabled: true,
      hasCredential: true,
    });
  });

  it("treats a missing `enabled` key as enabled", () => {
    // Matches how the daemon's own config hardening reads it.
    state.daemonConfig = { channels: { discord: { token: "abc" } } };
    expect(readDaemonChannel("discord")?.enabled).toBe(true);
  });

  it("reports a token-less channel as having no credential", () => {
    state.daemonConfig = { channels: { slack: { enabled: true } } };
    expect(readDaemonChannel("slack")).toEqual({
      enabled: true,
      hasCredential: false,
    });
  });

  it("returns null rather than throwing when the config is unreadable", () => {
    state.configReadThrows = true;
    expect(readDaemonChannel("telegram")).toBeNull();
  });

  it("returns null for a channel the daemon does not mention", () => {
    state.daemonConfig = { channels: { discord: { token: "abc" } } };
    expect(readDaemonChannel("slack")).toBeNull();
  });
});

describe("the decision table", () => {
  it("gives the channel to the daemon when it is alive and owns it", async () => {
    daemonOwns("telegram");

    const d = await resolveOwner("telegram", { hasLocalCredential: true });

    expect(d.owner).toBe("daemon");
    expect(d.daemonAlive).toBe(true);
    // The reason has to be actionable: it names both ways out.
    expect(d.reason).toMatch(/stop the daemon/i);
    expect(d.reason).toMatch(/openclaw\.json/);
  });

  it("gives it to JoyCreate when the daemon has that channel disabled", async () => {
    // This is the real situation on the dev machine: the daemon holds a Telegram
    // token but `enabled:false`, precisely because of the 409.
    daemonOwns("telegram", { enabled: false });

    const d = await resolveOwner("telegram", { hasLocalCredential: true });

    expect(d.owner).toBe("in-process");
    expect(d.daemonAlive).toBe(true);
  });

  it("gives it to JoyCreate when the daemon has no credential for it", async () => {
    daemonOwns("slack", { token: "", botToken: "", appToken: "" });

    const d = await resolveOwner("slack", { hasLocalCredential: true });

    expect(d.owner).toBe("in-process");
  });

  it("gives it to JoyCreate when the daemon is not running", async () => {
    state.daemonAlive = false;
    state.daemonConfig = {
      channels: { discord: { enabled: true, token: "daemon-token" } },
    };

    const d = await resolveOwner("discord", { hasLocalCredential: true });

    // The daemon's config says it wants Discord, but it is not running, so the
    // claim is irrelevant — nothing is polling.
    expect(d.owner).toBe("in-process");
    expect(d.daemonAlive).toBe(false);
  });

  it("is unavailable when JoyCreate has no credential", async () => {
    const d = await resolveOwner("discord", { hasLocalCredential: false });
    expect(d.owner).toBe("unavailable");
    expect(d.reason).toMatch(/no discord credentials/i);
  });

  it("prefers the daemon over an unavailable local channel", async () => {
    // Ownership is decided before local credentials are considered, so the UI
    // explains "the daemon runs this" rather than "you have no token".
    daemonOwns("discord");
    const d = await resolveOwner("discord", { hasLocalCredential: false });
    expect(d.owner).toBe("daemon");
  });

  it("falls back to in-process when the daemon config cannot be read", async () => {
    // A corrupt or missing daemon config must not block JoyCreate's own bot.
    state.daemonAlive = true;
    state.configReadThrows = true;

    const d = await resolveOwner("discord", { hasLocalCredential: true });

    expect(d.owner).toBe("in-process");
  });

  it("treats a probe that throws as the daemon being absent", async () => {
    // A failed probe is not evidence the daemon is running; assuming it were
    // would block the local bot for no reason.
    state.daemonProbeThrows = true;

    const d = await resolveOwner("telegram", { hasLocalCredential: true });

    expect(d.owner).toBe("in-process");
    expect(d.daemonAlive).toBe(false);
  });
});

describe("the telegramOwner setting outranks the daemon", () => {
  it("keeps Telegram local even while the daemon claims it", async () => {
    // `tryAutoStartTelegramBot` does not merely defer when the user picks
    // "local": it patches the daemon config to disable the channel and stops
    // the running daemon's poller over WS RPC, freeing the token. If this
    // reported "daemon", `telegram:start` would refuse a channel the app's own
    // autostart takes seconds later — the UI would contradict the app.
    state.telegramOwner = "local";
    daemonOwns("telegram");

    const d = await resolveOwner("telegram", { hasLocalCredential: true });

    expect(d.owner).toBe("in-process");
    expect(d.reason).toMatch(/poller is stopped/i);
  });

  it("still reports unavailable when local ownership has no token", async () => {
    state.telegramOwner = "local";
    daemonOwns("telegram");

    const d = await resolveOwner("telegram", { hasLocalCredential: false });

    expect(d.owner).toBe("unavailable");
  });

  it("defers to the daemon when the user explicitly chose daemon", async () => {
    state.telegramOwner = "daemon";
    daemonOwns("telegram");

    expect((await resolveOwner("telegram", { hasLocalCredential: true })).owner).toBe(
      "daemon",
    );
  });

  it("defaults to local when the setting is unset", async () => {
    state.telegramOwner = undefined;
    daemonOwns("telegram");

    expect((await resolveOwner("telegram", { hasLocalCredential: true })).owner).toBe(
      "in-process",
    );
  });

  it("defaults to local when settings cannot be read", async () => {
    // An unreadable settings file must not hand the channel to the daemon.
    state.settingsThrow = true;
    daemonOwns("telegram");

    expect((await resolveOwner("telegram", { hasLocalCredential: true })).owner).toBe(
      "in-process",
    );
  });

  it("does not apply the setting to other channels", async () => {
    state.telegramOwner = "local";
    daemonOwns("discord");

    expect((await resolveOwner("discord", { hasLocalCredential: true })).owner).toBe(
      "daemon",
    );
  });
});

describe("assertMayStart", () => {
  it("returns the decision when JoyCreate may run the channel", async () => {
    const d = await assertMayStart("discord", { hasLocalCredential: true });
    expect(d.owner).toBe("in-process");
  });

  it("throws the daemon's reason rather than starting a second poller", async () => {
    daemonOwns("telegram");
    await expect(
      assertMayStart("telegram", { hasLocalCredential: true }),
    ).rejects.toThrow(/owns telegram/i);
  });

  it("throws when there is no credential", async () => {
    await expect(
      assertMayStart("slack", { hasLocalCredential: false }),
    ).rejects.toThrow(/no slack credentials/i);
  });
});
