/**
 * The tool set Telegram and Discord conversations can call.
 *
 * The failure these guard against is quiet: a tool that is not wrapped, or a
 * result that never reaches the chat, does not throw anywhere — the bot just
 * says it did something, or says nothing, and the user cannot tell why.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { fakeDefs, existing } = vi.hoisted(() => ({
  fakeDefs: [] as Array<Record<string, unknown>>,
  existing: new Set<string>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/joycreate-test", getName: () => "JoyCreate", getVersion: () => "0.0.0-test" },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("@/pro/main/ipc/handlers/local_agent/tools/mcp_tools_adapter", () => ({
  getMcpAgentTools: () => fakeDefs,
}));

// Media paths are checked through an injected existence check rather than a
// mocked node:fs, which did not reliably reach the module under test.
const fileExists = (p: string) => existing.has(p);

import {
  MAX_TOOL_OUTPUT_CHARS,
  buildChannelTools,
  extractMediaPaths,
  truncateToolOutput,
} from "@/lib/channels/channel_agent_tools";

const callOpts = { toolCallId: "t1", messages: [] } as never;

function def(name: string, consent: "always" | "ask", execute: (args: any) => Promise<string>) {
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({ q: z.string().optional() }),
    defaultConsent: consent,
    execute: vi.fn(execute),
  };
}

beforeEach(() => {
  fakeDefs.length = 0;
  existing.clear();
});

describe("exposing the tools", () => {
  it("wraps every tool the local agent has, by name", () => {
    fakeDefs.push(
      def("read_document", "always", async () => "ok"),
      def("send_email", "ask", async () => "sent"),
    );
    const set = buildChannelTools({ channel: "telegram" });
    expect(set.names).toEqual(["read_document", "send_email"]);
    expect(Object.keys(set.tools)).toEqual(["read_document", "send_email"]);
  });

  it("marks state-changing tools, since a chat has no consent dialog", () => {
    fakeDefs.push(
      def("read_document", "always", async () => "ok"),
      def("send_email", "ask", async () => "sent"),
    );
    const set = buildChannelTools({ channel: "discord" });
    expect(set.destructiveNames).toEqual(["send_email"]);
    expect(set.tools.send_email.description).toMatch(/changes things in JoyCreate/);
    expect(set.tools.read_document.description).not.toMatch(/changes things/);
  });
});

describe("running a tool", () => {
  it("passes the arguments through and returns the tool's output", async () => {
    const d = def("read_document", "always", async (args) => `read ${args.q}`);
    fakeDefs.push(d);
    const set = buildChannelTools({ channel: "telegram" });

    const out = await set.tools.read_document.execute!({ q: "notes" }, callOpts);

    expect(out).toBe("read notes");
    expect(d.execute).toHaveBeenCalledWith({ q: "notes" }, expect.anything());
  });

  it("counts calls, so the handler knows the model acted", async () => {
    // Without this, a direct tool call looks like "the model did nothing" and
    // the handler escalates — running the same request a second time.
    fakeDefs.push(def("read_document", "always", async () => "ok"));
    const set = buildChannelTools({ channel: "telegram" });
    expect(set.callCount()).toBe(0);

    await set.tools.read_document.execute!({}, callOpts);
    await set.tools.read_document.execute!({}, callOpts);

    expect(set.callCount()).toBe(2);
    expect(set.lastSummary()).toBe("read_document: ok");
  });

  it("tells the handler a tool started, for the typing indicator", async () => {
    fakeDefs.push(def("read_document", "always", async () => "ok"));
    const onToolStart = vi.fn();
    const set = buildChannelTools({ channel: "telegram", onToolStart });

    await set.tools.read_document.execute!({}, callOpts);

    expect(onToolStart).toHaveBeenCalledWith("read_document");
  });

  it("truncates huge output before it floods the model's context", async () => {
    fakeDefs.push(def("list_everything", "always", async () => "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500)));
    const set = buildChannelTools({ channel: "discord" });

    const out = (await set.tools.list_everything.execute!({}, callOpts)) as string;

    expect(out.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 100);
    expect(out).toMatch(/output truncated: 500 more characters/);
  });

  it("lets a failure propagate rather than reporting success", async () => {
    fakeDefs.push(def("send_email", "ask", async () => {
      throw new Error("send_email failed: SMTP refused");
    }));
    const set = buildChannelTools({ channel: "telegram" });

    await expect(set.tools.send_email.execute!({}, callOpts)).rejects.toThrow(/SMTP refused/);
  });
});

describe("delivering generated media", () => {
  it("sends each generated file once, and skips paths that do not exist", async () => {
    const real = "C:\\Users\\me\\AppData\\Roaming\\JoyCreate\\images\\cat.png";
    existing.add(real);
    fakeDefs.push(def("generate_image", "ask", async () =>
      JSON.stringify({ filePath: real, preview: "/tmp/missing.png" }),
    ));
    const onMediaFile = vi.fn(async () => {});
    const set = buildChannelTools({ channel: "telegram", onMediaFile, fileExists });

    await set.tools.generate_image.execute!({}, callOpts);
    await set.tools.generate_image.execute!({}, callOpts);

    expect(onMediaFile).toHaveBeenCalledTimes(1);
    expect(onMediaFile).toHaveBeenCalledWith(real, "generate_image");
  });

  it("still returns the tool result when sending the media fails", async () => {
    existing.add("/data/out.mp4");
    fakeDefs.push(def("generate_video", "ask", async () => "saved /data/out.mp4"));
    const set = buildChannelTools({
      channel: "discord",
      fileExists,
      onMediaFile: async () => {
        throw new Error("upload too large");
      },
    });

    await expect(set.tools.generate_video.execute!({}, callOpts)).resolves.toBe("saved /data/out.mp4");
  });
});

describe("helpers", () => {
  it("finds media paths in plain text and in JSON-escaped Windows paths", () => {
    const json = JSON.stringify({ a: "C:\\imgs\\one.png" });
    expect(extractMediaPaths(json)).toEqual(["C:\\imgs\\one.png"]);
    expect(extractMediaPaths("made /home/u/clip.webm and /home/u/clip.webm")).toEqual(["/home/u/clip.webm"]);
    expect(extractMediaPaths("no media here, just report.pdf")).toEqual([]);
  });

  it("leaves short output alone", () => {
    expect(truncateToolOutput("short")).toBe("short");
  });
});
