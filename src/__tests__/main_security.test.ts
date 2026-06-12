import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import {
  isInternalNavigation,
  isSafeExternalUrl,
  isAllowedLoopbackIframe,
  isAllowedThirdPartyIframe,
  decidePermissionRequest,
  sanitizeRevealPath,
  sanitizeBindHost,
} from "@/main_security";

describe("main_security :: isInternalNavigation", () => {
  it("allows file:// origin (packaged renderer)", () => {
    expect(
      isInternalNavigation("file:///C:/Users/x/AppData/Local/JoyCreate/index.html"),
    ).toBe(true);
  });

  it("allows about:blank and about:srcdoc", () => {
    expect(isInternalNavigation("about:blank")).toBe(true);
    expect(isInternalNavigation("about:srcdoc")).toBe(true);
  });

  it("allows the dev server URL when provided", () => {
    expect(
      isInternalNavigation("http://localhost:5173/main_window/", {
        devServerUrl: "http://localhost:5173",
      }),
    ).toBe(true);
  });

  it("rejects a different dev-port even when dev server is set", () => {
    expect(
      isInternalNavigation("http://localhost:1234/", {
        devServerUrl: "http://localhost:5173",
      }),
    ).toBe(false);
  });

  it("rejects arbitrary http(s) origins", () => {
    expect(isInternalNavigation("https://evil.example.com/")).toBe(false);
    expect(isInternalNavigation("http://attacker.test/")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isInternalNavigation("not a url")).toBe(false);
    expect(isInternalNavigation("")).toBe(false);
  });

  it("rejects dangerous schemes", () => {
    expect(isInternalNavigation("javascript:alert(1)")).toBe(false);
    expect(isInternalNavigation("data:text/html,<script>1</script>")).toBe(false);
  });
});

describe("main_security :: isSafeExternalUrl", () => {
  it("accepts http and https", () => {
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("https://example.com")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,x")).toBe(false);
    expect(isSafeExternalUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeExternalUrl("ftp://example.com")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl("")).toBe(false);
  });
});

describe("main_security :: isAllowedLoopbackIframe", () => {
  it("accepts OpenClaw daemon / portal port range", () => {
    expect(isAllowedLoopbackIframe("http://127.0.0.1:18790/")).toBe(true);
    expect(isAllowedLoopbackIframe("http://localhost:18799/portal")).toBe(true);
  });

  it("accepts embedded n8n at :5678", () => {
    expect(isAllowedLoopbackIframe("http://localhost:5678/workflow/1")).toBe(true);
  });

  it("accepts MCP server :3777 and JoyCreate API :18793", () => {
    expect(isAllowedLoopbackIframe("http://127.0.0.1:3777/mcp")).toBe(true);
    expect(isAllowedLoopbackIframe("http://127.0.0.1:18793/api")).toBe(true);
  });

  it("rejects non-loopback hosts", () => {
    expect(isAllowedLoopbackIframe("http://192.168.1.10:18790/")).toBe(false);
    expect(isAllowedLoopbackIframe("http://attacker.com:18790/")).toBe(false);
  });

  it("rejects loopback on unauthorized ports", () => {
    expect(isAllowedLoopbackIframe("http://localhost:22/")).toBe(false);
    expect(isAllowedLoopbackIframe("http://localhost:80/")).toBe(false);
    expect(isAllowedLoopbackIframe("http://localhost:8080/")).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(isAllowedLoopbackIframe("file://localhost:18790/")).toBe(false);
    expect(isAllowedLoopbackIframe("ws://localhost:18790/")).toBe(false);
  });
});

describe("main_security :: isAllowedThirdPartyIframe", () => {
  it("accepts auth.privy.io and *.privy.io", () => {
    expect(isAllowedThirdPartyIframe("https://auth.privy.io/login")).toBe(true);
    expect(isAllowedThirdPartyIframe("https://app.privy.io/auth")).toBe(true);
  });

  it("rejects http:// privy", () => {
    expect(isAllowedThirdPartyIframe("http://auth.privy.io/")).toBe(false);
  });

  it("rejects look-alike domains", () => {
    expect(isAllowedThirdPartyIframe("https://privy.io.evil.com/")).toBe(false);
    expect(isAllowedThirdPartyIframe("https://privy-io.attacker.io/")).toBe(false);
  });
});

describe("main_security :: decidePermissionRequest", () => {
  const own = "file:///C:/JoyCreate/index.html";
  const dev = "http://localhost:5173";

  it("allows clipboard-sanitized-write from anywhere", () => {
    expect(
      decidePermissionRequest({
        permission: "clipboard-sanitized-write",
        requestingUrl: "https://random.example.com",
      }),
    ).toBe(true);
  });

  it("allows media only from the renderer's own origin (file://)", () => {
    expect(
      decidePermissionRequest({ permission: "media", requestingUrl: own }),
    ).toBe(true);
    expect(
      decidePermissionRequest({
        permission: "media",
        requestingUrl: "https://untrusted.example.com",
      }),
    ).toBe(false);
  });

  it("allows media from the dev server", () => {
    expect(
      decidePermissionRequest({
        permission: "media",
        requestingUrl: "http://localhost:5173/main_window",
        devServerUrl: dev,
      }),
    ).toBe(true);
  });

  it("always denies geolocation, display-capture, hid, serial, usb, bluetooth", () => {
    for (const p of [
      "geolocation",
      "display-capture",
      "hid",
      "serial",
      "usb",
      "bluetooth",
      "clipboard-read",
      "midi",
      "midiSysex",
      "pointerLock",
      "openExternal",
      "window-management",
      "window-placement",
      "keyboardLock",
      "idle-detection",
    ]) {
      expect(
        decidePermissionRequest({ permission: p, requestingUrl: own }),
      ).toBe(false);
    }
  });

  it("denies unknown permissions by default", () => {
    expect(
      decidePermissionRequest({
        permission: "made-up-permission",
        requestingUrl: own,
      }),
    ).toBe(false);
  });

  it("denies media when requesting URL is missing", () => {
    expect(
      decidePermissionRequest({ permission: "media", requestingUrl: undefined }),
    ).toBe(false);
    expect(
      decidePermissionRequest({ permission: "media", requestingUrl: "" }),
    ).toBe(false);
  });
});

describe("main_security :: sanitizeRevealPath", () => {
  it("accepts paths inside an allowed root", () => {
    const root = path.resolve(os.tmpdir(), "joycreate-test-root");
    const candidate = path.join(root, "sub", "file.txt");
    expect(sanitizeRevealPath(candidate, [root])).toBe(path.resolve(candidate));
  });

  it("accepts the root itself", () => {
    const root = path.resolve(os.tmpdir(), "joycreate-test-root");
    expect(sanitizeRevealPath(root, [root])).toBe(path.resolve(root));
  });

  it("rejects paths that escape every allowed root", () => {
    const root = path.resolve(os.tmpdir(), "joycreate-test-root");
    const escape = path.resolve(os.tmpdir(), "outside-root", "file.txt");
    expect(sanitizeRevealPath(escape, [root])).toBeNull();
  });

  it("rejects null-byte injection", () => {
    expect(sanitizeRevealPath("C:\\fake\0path", ["C:\\"])).toBeNull();
  });

  it("rejects empty / non-string input", () => {
    expect(sanitizeRevealPath("", ["C:\\"])).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(sanitizeRevealPath(null, ["C:\\"])).toBeNull();
    // @ts-expect-error testing runtime guard
    expect(sanitizeRevealPath(undefined, ["C:\\"])).toBeNull();
  });

  it("ignores empty / falsy entries in the allow list", () => {
    const root = path.resolve(os.tmpdir(), "joycreate-test-root");
    const inside = path.join(root, "x.txt");
    expect(
      sanitizeRevealPath(inside, ["", root, undefined as unknown as string]),
    ).toBe(path.resolve(inside));
  });

  it("does not treat a sibling directory prefix as 'inside'", () => {
    // Classic path-traversal trap: /opt/data should NOT match /opt/data-evil.
    const root = path.resolve("/opt/data");
    const sibling = path.resolve("/opt/data-evil/secret.txt");
    expect(sanitizeRevealPath(sibling, [root])).toBeNull();
  });
});

describe("main_security :: sanitizeBindHost", () => {
  it("defaults to loopback when input is missing", () => {
    expect(sanitizeBindHost(undefined)).toBe("127.0.0.1");
    expect(sanitizeBindHost("")).toBe("127.0.0.1");
    expect(sanitizeBindHost(null)).toBe("127.0.0.1");
  });

  it("passes loopback aliases through", () => {
    expect(sanitizeBindHost("127.0.0.1")).toBe("127.0.0.1");
    expect(sanitizeBindHost("localhost")).toBe("localhost");
    expect(sanitizeBindHost("::1")).toBe("::1");
  });

  it("clamps 0.0.0.0 to loopback by default", () => {
    expect(sanitizeBindHost("0.0.0.0")).toBe("127.0.0.1");
  });

  it("allows 0.0.0.0 when external exposure is explicitly enabled", () => {
    expect(
      sanitizeBindHost("0.0.0.0", { allowExternalExposure: true }),
    ).toBe("0.0.0.0");
  });

  it("clamps non-loopback hosts to loopback by default", () => {
    expect(sanitizeBindHost("192.168.1.10")).toBe("127.0.0.1");
    expect(sanitizeBindHost("attacker.example.com")).toBe("127.0.0.1");
  });

  it("allows non-loopback hosts when external exposure is enabled", () => {
    expect(
      sanitizeBindHost("100.64.0.5", { allowExternalExposure: true }),
    ).toBe("100.64.0.5");
  });

  it("honours a custom loopback default", () => {
    expect(
      sanitizeBindHost("0.0.0.0", { loopbackDefault: "::1" }),
    ).toBe("::1");
  });
});
