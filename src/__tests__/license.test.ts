import { describe, expect, it } from "vitest";

import {
  DEFAULT_LICENSE_ID,
  LICENSE_TERMS_VERSION,
  buildLicenseTerms,
  checkLicense,
  hashLicenseTerms,
  normalizeLicense,
} from "@/lib/onchain/license";

describe("buildLicenseTerms", () => {
  it("applies permissive defaults", () => {
    const terms = buildLicenseTerms();
    expect(terms).toEqual({
      schema: LICENSE_TERMS_VERSION,
      id: DEFAULT_LICENSE_ID,
      spdx: null,
      commercial: false,
      derivative: false,
      runtimeExecution: false,
      expiry: null,
      seats: null,
      termsUri: null,
    });
  });

  it("preserves supplied fields", () => {
    const terms = buildLicenseTerms({
      id: "joy/commercial-runtime/1.0",
      commercial: true,
      derivative: true,
      runtimeExecution: true,
      expiry: "2030-01-01T00:00:00.000Z",
      seats: 5,
      termsUri: "ipfs://bafyterms",
    });
    expect(terms.commercial).toBe(true);
    expect(terms.runtimeExecution).toBe(true);
    expect(terms.seats).toBe(5);
    expect(terms.termsUri).toBe("ipfs://bafyterms");
  });
});

describe("normalizeLicense", () => {
  it("returns an existing terms object unchanged", () => {
    const terms = buildLicenseTerms({ commercial: true });
    expect(normalizeLicense(terms)).toBe(terms);
  });

  it("maps a plain SPDX string onto terms", () => {
    const terms = normalizeLicense("CC-BY-4.0");
    expect(terms.spdx).toBe("CC-BY-4.0");
    expect(terms.id).toBe("spdx/cc-by-4.0");
    expect(terms.commercial).toBe(false);
  });

  it("falls back to the default for empty / nullish input", () => {
    expect(normalizeLicense(undefined).id).toBe(DEFAULT_LICENSE_ID);
    expect(normalizeLicense("  ").id).toBe(DEFAULT_LICENSE_ID);
  });
});

describe("checkLicense", () => {
  it("denies uses the terms forbid", () => {
    const terms = buildLicenseTerms();
    expect(checkLicense(terms, "commercial").allowed).toBe(false);
    expect(checkLicense(terms, "derivative").allowed).toBe(false);
    expect(checkLicense(terms, "runtimeExecution").allowed).toBe(false);
  });

  it("allows uses the terms grant", () => {
    const terms = buildLicenseTerms({
      commercial: true,
      derivative: true,
      runtimeExecution: true,
    });
    expect(checkLicense(terms, "commercial").allowed).toBe(true);
    expect(checkLicense(terms, "runtimeExecution").allowed).toBe(true);
  });

  it("enforces expiry regardless of the granted right", () => {
    const terms = buildLicenseTerms({
      commercial: true,
      expiry: "2020-01-01T00:00:00.000Z",
    });
    const result = checkLicense(terms, "commercial", new Date("2021-01-01"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("allows a use before expiry", () => {
    const terms = buildLicenseTerms({
      commercial: true,
      expiry: "2030-01-01T00:00:00.000Z",
    });
    expect(checkLicense(terms, "commercial", new Date("2025-01-01")).allowed).toBe(true);
  });
});

describe("hashLicenseTerms", () => {
  it("is deterministic and order-independent", () => {
    const a = buildLicenseTerms({ commercial: true, seats: 3 });
    const b = buildLicenseTerms({ seats: 3, commercial: true });
    expect(hashLicenseTerms(a)).toBe(hashLicenseTerms(b));
    expect(hashLicenseTerms(a)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when terms change", () => {
    const a = buildLicenseTerms({ commercial: false });
    const b = buildLicenseTerms({ commercial: true });
    expect(hashLicenseTerms(a)).not.toBe(hashLicenseTerms(b));
  });
});
