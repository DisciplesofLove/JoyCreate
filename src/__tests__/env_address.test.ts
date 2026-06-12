/**
 * env_address — LR7 mainnet-cutover env override unit tests.
 *
 * Verifies the precedence (Vite env → process.env → fallback) used to fill the
 * Arbitrum One addresses without a code change.
 */

import { describe, it, expect, afterEach } from "vitest";

import { envAddress } from "@/config/env_address";

const ADDR = "0x1234567890123456789012345678901234567890";
const KEY = "VITE_TEST_ENV_ADDRESS_LR7";

afterEach(() => {
  delete process.env[KEY];
});

describe("envAddress", () => {
  it("returns the fallback when no env value is set", () => {
    expect(envAddress(KEY, "0xfallback")).toBe("0xfallback");
  });

  it("returns the process.env value when present", () => {
    process.env[KEY] = ADDR;
    expect(envAddress(KEY, "0xfallback")).toBe(ADDR);
  });

  it("treats an empty string as unset and uses the fallback", () => {
    process.env[KEY] = "";
    expect(envAddress(KEY, "0xfallback")).toBe("0xfallback");
  });
});
