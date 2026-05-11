/**
 * Sovereign Blueprint — parser unit tests.
 * Pure: no DB, no IPC.
 */

import { describe, it, expect } from "vitest";
import {
  parseBlueprint,
  topoSort,
  computeDeps,
} from "@/lib/blueprint/parser";
import { BlueprintParseError } from "@/types/blueprint_types";

const HASH = "a".repeat(64);

const minimalYaml = `
id: bp-1
version: "1.0.0"
author_did: did:joy:alice
nodes:
  - id: scrape
    skill: firecrawl-deep-scrape
    params:
      url: https://example.com
    verify_intent: ${HASH}
`;

describe("parseBlueprint — happy path", () => {
  it("parses a minimal valid blueprint", () => {
    const bp = parseBlueprint(minimalYaml);
    expect(bp.id).toBe("bp-1");
    expect(bp.version).toBe("1.0.0");
    expect(bp.author_did).toBe("did:joy:alice");
    expect(bp.nodes).toHaveLength(1);
    expect(bp.nodes[0].verify_intent).toBe(HASH);
  });

  it("infers depends_on from {{ref}} template tags", () => {
    const yaml = `
id: bp-2
version: "1"
author_did: did:joy:bob
nodes:
  - id: a
    skill: firecrawl-deep-scrape
    params: { url: "x" }
    verify_intent: ${HASH}
  - id: b
    skill: opus-reasoning
    params: { input: "{{a.output}}" }
    verify_intent: ${HASH}
`;
    const bp = parseBlueprint(yaml);
    const deps = computeDeps(bp);
    expect(deps.get("b")?.has("a")).toBe(true);
    const order = topoSort(bp);
    expect(order.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("parseBlueprint — failure modes", () => {
  it("rejects malformed YAML", () => {
    expect(() => parseBlueprint("id: [unclosed")).toThrow(BlueprintParseError);
  });

  it("rejects missing verify_intent", () => {
    const yaml = `
id: bp
version: "1"
author_did: did:joy:x
nodes:
  - id: a
    skill: s
    params: {}
`;
    expect(() => parseBlueprint(yaml)).toThrow(BlueprintParseError);
  });

  it("rejects non-hex verify_intent", () => {
    const yaml = minimalYaml.replace(HASH, "not-a-hash");
    expect(() => parseBlueprint(yaml)).toThrow(BlueprintParseError);
  });

  it("rejects invalid DID", () => {
    const yaml = minimalYaml.replace("did:joy:alice", "not-a-did");
    expect(() => parseBlueprint(yaml)).toThrow(BlueprintParseError);
  });

  it("rejects duplicate node ids", () => {
    const yaml = `
id: bp
version: "1"
author_did: did:joy:x
nodes:
  - id: a
    skill: s1
    verify_intent: ${HASH}
  - id: a
    skill: s2
    verify_intent: ${HASH}
`;
    expect(() => parseBlueprint(yaml)).toThrow(/Duplicate node id/);
  });

  it("rejects unknown depends_on", () => {
    const yaml = `
id: bp
version: "1"
author_did: did:joy:x
nodes:
  - id: a
    skill: s
    verify_intent: ${HASH}
    depends_on: [ghost]
`;
    expect(() => parseBlueprint(yaml)).toThrow(/unknown node "ghost"/);
  });

  it("rejects cycles", () => {
    const yaml = `
id: bp
version: "1"
author_did: did:joy:x
nodes:
  - id: a
    skill: s
    verify_intent: ${HASH}
    depends_on: [b]
  - id: b
    skill: s
    verify_intent: ${HASH}
    depends_on: [a]
`;
    expect(() => parseBlueprint(yaml)).toThrow(/cycle/);
  });
});
