/**
 * main_security.ts — Electron security hardening helpers for the main process.
 *
 * These helpers are extracted from main.ts so they can be unit-tested without
 * spinning up a full Electron instance (vitest + happy-dom).
 *
 * Background: JoyCreate's renderer already runs with `nodeIntegration: false`,
 * `contextIsolation: true`, and a tight preload allow-list, but several
 * Electron security recommendations (#8 navigation, #11 window-open, #12
 * webview attributes, permissions) were not enforced at the main-process
 * level. A compromised renderer or malicious DOM (e.g. a webview pointing at
 * untrusted content) could otherwise:
 *   - mutate a <webview> tag to flip nodeIntegration back on,
 *   - call window.open() to spawn a full BrowserWindow with default prefs,
 *   - navigate the main window to an attacker-controlled origin and then
 *     pivot through any IPC channel,
 *   - grant itself camera / mic / geolocation / clipboard access.
 *
 * This module provides reusable, pure helpers for each of those concerns. The
 * main process wires them up in main.ts.
 */

/**
 * Origins that the renderer is allowed to navigate to / from. file:// and the
 * Vite dev server are the renderer's own origin. We also allow loopback
 * gateway / studio ports because the renderer iframes the OpenClaw portal,
 * the embedded n8n UI, and a couple of other co-located services.
 *
 * The auth.privy.io origin is whitelisted because the embedded wallet flow
 * iframes its login UI; we also accept any *.privy.io subdomain. This list
 * is intentionally tiny — every entry is a deliberate trust decision.
 */
export interface NavigationPolicyOptions {
  /** Vite dev server URL when running under `npm start`; undefined in packaged builds. */
  devServerUrl?: string;
}

/**
 * Returns true when a renderer should be allowed to navigate to `targetUrl`.
 *
 * The renderer's "home" origin is `file://` (packaged) or the Vite dev server
 * (development). All other navigations are treated as external links: they
 * should be opened in the user's default browser via `shell.openExternal`,
 * not in the BrowserWindow itself.
 *
 * The few exceptions (loopback gateway ports, Privy auth) match the
 * `setupResponseHeaderOverrides` allow-list in main.ts.
 */
export function isInternalNavigation(
  targetUrl: string,
  opts: NavigationPolicyOptions = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    // Malformed URL — refuse. Electron will block the navigation.
    return false;
  }

  // The renderer's own origin: file:// in packaged builds, http://localhost:5173
  // (or similar) in dev. about:blank is the renderer's bootstrap origin.
  if (parsed.protocol === "file:") return true;
  if (parsed.href === "about:blank" || parsed.href === "about:srcdoc") return true;

  if (opts.devServerUrl) {
    try {
      const dev = new URL(opts.devServerUrl);
      if (parsed.origin === dev.origin) return true;
    } catch {
      // Ignore malformed dev server URL — fall through to deny.
    }
  }

  return false;
}

/**
 * Returns true when an outbound HTTP(S) URL should be opened in the user's
 * default browser via shell.openExternal. We refuse anything that isn't
 * http: or https: (no file:, javascript:, data:, etc.) to guarantee the
 * shell call can't be turned into local file execution.
 */
export function isSafeExternalUrl(targetUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Loopback / co-located service origins the renderer is permitted to iframe.
 *
 * This matches the response-header allow-list in `setupResponseHeaderOverrides`
 * (X-Frame-Options stripping) so we don't accidentally allow rendering of
 * content whose frame-ancestors policy we just stripped without also blocking
 * navigation top-level.
 */
const LOOPBACK_FRAMING_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Returns true when `targetUrl` points at a co-located loopback service the
 * renderer is allowed to embed in an iframe (OpenClaw portal 18790-18799,
 * embedded n8n at 5678, MCP server 3777, JoyCreate API 18793).
 */
export function isAllowedLoopbackIframe(targetUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!LOOPBACK_FRAMING_HOSTS.has(parsed.hostname)) return false;
  const port = Number(parsed.port);
  if (!Number.isFinite(port)) return false;
  // OpenClaw daemon / gateway portal range, embedded n8n, MCP, JoyCreate API.
  if (port >= 18790 && port <= 18799) return true;
  if (port === 5678) return true;
  if (port === 3777) return true;
  if (port === 18793) return true;
  return false;
}

/**
 * Privy embedded-wallet auth origins. Kept as a tiny allow-list because the
 * iframe needs HOTP / passkey login, which can't be redirected to the system
 * browser without breaking the user-visible flow.
 */
export function isAllowedThirdPartyIframe(targetUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "auth.privy.io") return true;
  if (parsed.hostname.endsWith(".privy.io")) return true;
  return false;
}

/**
 * Permission-request policy.
 *
 * Electron's renderer can call `navigator.mediaDevices.getUserMedia(...)`,
 * `Notification.requestPermission()`, `navigator.geolocation`, etc. without
 * any prompt unless the main process registers a request handler. We default
 * to "deny" for every dangerous permission and only allow a small set that
 * JoyCreate genuinely uses.
 *
 * `media` / `mediaKeySystem`: needed by the Voice Assistant + Video Studio.
 *   Only allowed from the renderer's own origin (file:// or dev server) so a
 *   webview / iframe of untrusted content cannot pop a mic / camera prompt.
 * `clipboard-sanitized-write`: needed for copy-to-clipboard UX.
 * `display-capture`: explicitly denied — there is no first-party feature
 *   that needs it today and granting it silently to any iframe is dangerous.
 *
 * Returns true to allow, false to deny.
 */
export interface PermissionDecisionInput {
  permission: string;
  /**
   * The requesting frame's URL. May be empty/null when Electron can't
   * determine it (treat as untrusted: deny).
   */
  requestingUrl: string | null | undefined;
  /** Vite dev URL when running under `npm start`; undefined in packaged builds. */
  devServerUrl?: string;
}

export function decidePermissionRequest(input: PermissionDecisionInput): boolean {
  const { permission } = input;
  const fromOwnOrigin = isFromOwnOrigin(
    input.requestingUrl ?? "",
    input.devServerUrl,
  );

  switch (permission) {
    // Always allow — internal-only UX.
    case "clipboard-sanitized-write":
    case "fullscreen":
      return true;

    // Allow only from the renderer's own origin (file:// or dev server).
    case "media":
    case "mediaKeySystem":
    case "notifications":
      return fromOwnOrigin;

    // Always deny — JoyCreate does not use these.
    case "geolocation":
    case "midi":
    case "midiSysex":
    case "pointerLock":
    case "openExternal":
    case "display-capture":
    case "clipboard-read":
    case "hid":
    case "serial":
    case "usb":
    case "bluetooth":
    case "window-management":
    case "window-placement":
    case "keyboardLock":
    case "idle-detection":
      return false;

    default:
      // Unknown permission: default deny.
      return false;
  }
}

function isFromOwnOrigin(url: string, devServerUrl?: string): boolean {
  if (!url) return false;
  if (url.startsWith("file://")) return true;
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl);
      const candidate = new URL(url);
      if (candidate.origin === dev.origin) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Sanitize a renderer-supplied path before passing it to
 * `shell.showItemInFolder`. JoyCreate uses this to reveal app-generated
 * artifacts (images, videos, libreoffice docs, exports) in the OS file
 * manager. We allow only paths that resolve under one of the known
 * "JoyCreate-managed" roots — never an arbitrary system path the renderer
 * names.
 *
 * Returns the canonicalised absolute path when safe, or null when the path
 * escapes every allowed root.
 *
 * Allowed roots must be passed in by the caller (so this helper stays pure).
 * They will typically be:
 *   - app.getPath("userData")     — settings, generated assets, DB
 *   - app.getPath("downloads")    — explicit user downloads
 *   - app.getPath("home") + "/.openclaw" — daemon workspace
 *   - the open workspace root (Code Studio)
 */
import * as nodePath from "node:path";

export function sanitizeRevealPath(
  candidate: string,
  allowedRoots: readonly string[],
): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  // Reject null bytes outright — they corrupt path parsing on every OS.
  if (candidate.includes("\0")) return null;

  let absolute: string;
  try {
    absolute = nodePath.resolve(candidate);
  } catch {
    return null;
  }

  for (const root of allowedRoots) {
    if (!root) continue;
    let normalisedRoot: string;
    try {
      normalisedRoot = nodePath.resolve(root);
    } catch {
      continue;
    }
    if (
      absolute === normalisedRoot ||
      absolute.startsWith(normalisedRoot + nodePath.sep)
    ) {
      return absolute;
    }
  }

  return null;
}

/**
 * Sanitize a user-supplied bind host for an HTTP server. We accept the
 * loopback aliases by default and only allow a non-loopback bind when the
 * caller has explicitly opted in (e.g. Tailscale `exposeServices: true`).
 *
 * Returns the host string to actually pass to `server.listen(port, host)`.
 *
 * Defense-in-depth: even if a UI bug or compromised settings file writes
 * `webhookHost: "0.0.0.0"` into config, this helper keeps the server
 * confined to loopback. The user has to actively flip a Tailscale-style
 * exposure flag to widen it.
 */
export interface BindHostPolicyOptions {
  /** When true, allow the caller-supplied host even if it isn't loopback. */
  allowExternalExposure?: boolean;
  /** Override the loopback default. Useful for tests. */
  loopbackDefault?: string;
}

const LOOPBACK_ALIASES = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0.0.0.0", // historical alias used by a few configs to mean "the default" — clamp to loopback
]);

export function sanitizeBindHost(
  requested: string | null | undefined,
  opts: BindHostPolicyOptions = {},
): string {
  const fallback = opts.loopbackDefault ?? "127.0.0.1";
  if (!requested || typeof requested !== "string") return fallback;
  const trimmed = requested.trim();
  if (trimmed.length === 0) return fallback;

  if (LOOPBACK_ALIASES.has(trimmed)) {
    // 0.0.0.0 → clamp to loopback unless external exposure is explicitly on.
    if (trimmed === "0.0.0.0" && !opts.allowExternalExposure) {
      return fallback;
    }
    return trimmed === "0.0.0.0" ? "0.0.0.0" : trimmed;
  }

  // Any other host is a non-loopback bind. Allow only when external exposure
  // has been explicitly enabled. Otherwise clamp to loopback.
  return opts.allowExternalExposure ? trimmed : fallback;
}
