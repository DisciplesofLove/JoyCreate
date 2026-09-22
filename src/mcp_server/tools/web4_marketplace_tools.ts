/**
 * MCP Tools — Web 4.0 Marketplace Pipeline (ERC-8004 / ERC-1144 / X402)
 *
 * Exposes the full Licensed Runtime Asset pipeline as high-level,
 * natural-language-mapped tools so external AI agents can operate a store and
 * run assets end to end:
 *
 *   store_register    → register an ENS-named store (StoreRegistry + ERC-8004 id)
 *   agent_authorize   → create an AgentMandate spend cap (+ optional setAgent)   [LR4]
 *   drop_launch       → create a priced ERC-1155 drop under a store (EditionController)
 *   discover          → fetch the ERC-1144 interface blueprint for a drop/store/agent
 *                       (this IS "blueprint_get": it returns identity + runtime + reputation)
 *   purchase_execute  → pay-per-mint a drop via the X402 USDC rail (spends real funds);
 *                       accepts an optional mandateId to spend under a mandate    [LR4]
 *   reputation_submit → submit feedback for a settled purchase (ReputationRegistry) [LR3]
 *   license_check     → evaluate a structured license against a requested use     [LR2]
 *   runtime_invoke    → resolve an asset's gated runtime manifest, and (LR8) fetch its
 *                       skillCID from IPFS and execute it locally behind the
 *                       license + Proof-of-Use gate                              [LR5/LR8]
 *
 * These map directly onto already-registered IPC handlers (glue:*, broker:*,
 * x402:*, erc8004:*) plus the pure LR2 license predicate. Business logic stays in
 * the main process / shared libs — these tools are thin wrappers.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ipcMain } from "electron";

import { checkLicense, normalizeLicense, type LicenseUse } from "@/lib/onchain/license";
import { invokeAndMeter } from "@/lib/onchain/runtime_metering";
import { DEFAULT_GLUE_CHAIN, type GlueChainId } from "@/config/glue";

// Helper to invoke existing IPC handlers from MCP context.
async function invokeHandler(channel: string, ...args: unknown[]): Promise<any> {
  const handler = (ipcMain as any)._invokeHandlers?.get(channel);
  if (handler) {
    return handler({ sender: { id: -1 } }, ...args);
  }
  throw new Error(
    `IPC handler not found: ${channel}. Ensure handlers are registered before MCP server starts.`,
  );
}

const CHAIN_DESC =
  "Target chain key: 'arbitrumSepolia' (default) or 'arbitrumOne'.";

export function registerWeb4MarketplaceTools(server: McpServer) {
  // ── store_register ───────────────────────────────────────────────
  server.registerTool(
    "store_register",
    {
      description:
        "Register a new ENS-named storefront on the StoreRegistry. The store is bound to an " +
        "ERC-8004 agent identity and addressable as <slug>.store.<marketplace>.eth. " +
        "Returns the new storeId. Uses the local signing wallet (gas-only).",
      inputSchema: {
        slug: z
          .string()
          .describe("Store slug / ENS label, e.g. 'acme-models'. Must be unique."),
        agentId: z
          .string()
          .optional()
          .describe("ERC-8004 agent id to bind as the store operator (default '0' = owner)."),
        payFee: z
          .boolean()
          .optional()
          .describe(
            "Charge the x402 store-registration fee before registering (routed via RevenueSplitter). " +
              "On a fee-ready chain a failed payment aborts the registration.",
          ),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const result = await invokeHandler("glue:register-store", {
          chain: params.chain,
          slug: params.slug,
          agentId: params.agentId,
          payFee: params.payFee,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error registering store: ${err.message}` }],
        };
      }
    },
  );

  // ── drop_launch ──────────────────────────────────────────────────
  server.registerTool(
    "drop_launch",
    {
      description:
        "Launch a priced ERC-1155 drop under a store via the EditionController. The drop is keyed " +
        "by an asset leaf (IPLD Merkle root of the content shard) and priced in USDC atomic units " +
        "(6 decimals; e.g. '1000000' = 1 USDC). Returns the new dropId. Uses the local signing wallet.",
      inputSchema: {
        storeId: z.string().describe("The storeId returned by store_register."),
        assetLeaf: z
          .string()
          .describe("Asset leaf — the IPLD/Merkle root hash (0x-prefixed) of the content shard."),
        price: z
          .string()
          .optional()
          .describe("Price in USDC atomic units (6 decimals). '0' = free. Default '0'."),
        maxSupply: z
          .string()
          .optional()
          .describe("Maximum editions mintable. '0' = unlimited. Default '0'."),
        requiresProof: z
          .boolean()
          .optional()
          .describe("If true, buyers need a proof grant before minting (PoU gate)."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const result = await invokeHandler("glue:create-drop", {
          chain: params.chain,
          storeId: params.storeId,
          assetLeaf: params.assetLeaf,
          price: params.price,
          maxSupply: params.maxSupply,
          requiresProof: params.requiresProof,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error launching drop: ${err.message}` }],
        };
      }
    },
  );

  // ── discover ─────────────────────────────────────────────────────
  server.registerTool(
    "discover",
    {
      description:
        "Discover a marketplace resource as an ERC-1144 interface blueprint. Returns identity " +
        "(ERC-8004 + ENS), reputation, store metadata, capabilities (including the X402 payment " +
        "requirements and the invocation contract to mint), and contract addresses. " +
        "Use this before purchase_execute to learn the price, payTo address, and asset.",
      inputSchema: {
        kind: z
          .enum(["drop", "store", "agent"])
          .describe("What to discover: a 'drop', a 'store', or an 'agent'."),
        id: z
          .string()
          .describe("The dropId, storeId, or agentId to inspect (matching 'kind')."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        let result: unknown;
        if (params.kind === "drop") {
          result = await invokeHandler("broker:drop-blueprint", {
            chain: params.chain,
            dropId: params.id,
          });
        } else if (params.kind === "store") {
          result = await invokeHandler("broker:store-blueprint", {
            chain: params.chain,
            storeId: params.id,
          });
        } else {
          result = await invokeHandler("broker:agent-blueprint", {
            chain: params.chain,
            agentId: params.id,
          });
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error discovering ${params.kind}: ${err.message}` }],
        };
      }
    },
  );

  // ── purchase_execute ─────────────────────────────────────────────
  server.registerTool(
    "purchase_execute",
    {
      description:
        "Execute an end-to-end pay-per-mint purchase of a drop over the X402 USDC rail. " +
        "This SPENDS REAL FUNDS: it signs an EIP-3009 USDC authorization, settles the payment " +
        "through the RevenueSplitter (80/10/10), grants proof if required, then mints the edition " +
        "via the EditionController. Returns the minted tokenId, payment receipt, and tx hashes. " +
        "Call discover first to confirm the price. Uses the local signing wallet — only invoke " +
        "with explicit user approval. Pass mandateId to spend under an on-chain AgentMandate " +
        "(the spend cap is enforced on-chain before settlement, and recordSpend is charged after).",
      inputSchema: {
        dropId: z.string().describe("The dropId to purchase (from discover / drop_launch)."),
        mandateId: z
          .string()
          .optional()
          .describe("Optional AgentMandate id to charge the purchase against (LR4 spend cap)."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const result = params.mandateId
          ? await invokeHandler("x402:purchase-edition-with-mandate", {
              chain: params.chain,
              dropId: params.dropId,
              mandateId: params.mandateId,
            })
          : await invokeHandler("x402:purchase-edition", {
              chain: params.chain,
              dropId: params.dropId,
            });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error executing purchase: ${err.message}` }],
        };
      }
    },
  );

  // ── agent_authorize ──────────────────────────────────────────────
  server.registerTool(
    "agent_authorize",
    {
      description:
        "Authorize an operating agent (LR4). Creates an on-chain AgentMandate that lets the given " +
        "agent address spend up to a USDC cap on the principal's behalf, and optionally binds that " +
        "agent as a store's operator via setAgent. Returns the new mandateId (and the setAgent tx " +
        "when storeId is supplied). The mandate spend cap is enforced on-chain by purchase_execute.",
      inputSchema: {
        agent: z
          .string()
          .describe("The operating agent's wallet address (0x…) to grant the mandate to."),
        spendLimit: z
          .string()
          .describe("Spend cap in USDC atomic units (6 decimals; e.g. '5000000' = 5 USDC)."),
        expiry: z
          .string()
          .optional()
          .describe("Optional unix-seconds expiry. '0' or omitted = no expiry."),
        actionScope: z
          .string()
          .optional()
          .describe("Optional 0x-prefixed 32-byte scope hash limiting the mandate's actions."),
        storeId: z
          .string()
          .optional()
          .describe("Optional storeId to also bind this agent as the store operator (setAgent)."),
        agentId: z
          .string()
          .optional()
          .describe("ERC-8004 agentId for the setAgent binding (required when storeId is set)."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const mandate = await invokeHandler("glue:create-mandate", {
          chain: params.chain,
          agent: params.agent,
          spendLimit: params.spendLimit,
          expiry: params.expiry,
          actionScope: params.actionScope,
        });
        let setAgent: unknown;
        if (params.storeId) {
          if (!params.agentId) {
            throw new Error("agentId is required to bind a store operator (setAgent)");
          }
          setAgent = await invokeHandler("glue:set-store-agent", {
            chain: params.chain,
            storeId: params.storeId,
            agentId: params.agentId,
          });
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ mandate, setAgent }, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error authorizing agent: ${err.message}` }],
        };
      }
    },
  );

  // ── reputation_submit ────────────────────────────────────────────
  server.registerTool(
    "reputation_submit",
    {
      description:
        "Submit reputation feedback for a settled purchase (LR3). Records a client→server score " +
        "(0–100) on the ReputationRegistry so a store's averageScore reflects real transactions. " +
        "The serving agent must have authorized feedback (purchase_execute already submits feedback " +
        "automatically; use this only for manual/out-of-band feedback).",
      inputSchema: {
        clientId: z.string().describe("The buyer's ERC-8004 agent id (clientId)."),
        serverId: z.string().describe("The store's serving agent id (serverId)."),
        score: z.number().describe("Feedback score in [0, 100]."),
        feedbackUri: z
          .string()
          .optional()
          .describe("Optional ipfs:// pointer to a pinned purchase/feedback receipt."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const result = await invokeHandler("erc8004:submit-feedback", {
          chain: params.chain,
          clientId: params.clientId,
          serverId: params.serverId,
          score: params.score,
          feedbackUri: params.feedbackUri,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error submitting feedback: ${err.message}` }],
        };
      }
    },
  );

  // ── license_check ────────────────────────────────────────────────
  server.registerTool(
    "license_check",
    {
      description:
        "Evaluate a structured license (LR2) against a requested use and return allow/deny. " +
        "Accepts either a full license terms object or a plain SPDX string (e.g. 'CC-BY-4.0'); " +
        "the use is one of 'commercial', 'derivative', or 'runtimeExecution'. Expiry is always " +
        "enforced. Use this before runtime_invoke or a commercial/derivative action.",
      inputSchema: {
        use: z
          .enum(["commercial", "derivative", "runtimeExecution"])
          .describe("The use to authorize against the license."),
        spdx: z
          .string()
          .optional()
          .describe("A plain SPDX license string (e.g. 'CC-BY-4.0'). Mutually exclusive with terms."),
        terms: z
          .object({
            id: z.string().optional(),
            spdx: z.string().nullable().optional(),
            commercial: z.boolean().optional(),
            derivative: z.boolean().optional(),
            runtimeExecution: z.boolean().optional(),
            expiry: z.string().nullable().optional(),
            seats: z.number().nullable().optional(),
            termsUri: z.string().nullable().optional(),
          })
          .optional()
          .describe("A structured license terms object (from a drop blueprint's license node)."),
      },
    },
    async (params) => {
      try {
        const license = normalizeLicense(params.terms ?? params.spdx ?? undefined);
        const result = checkLicense(license, params.use as LicenseUse);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, use: params.use, license }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error checking license: ${err.message}` }],
        };
      }
    },
  );

  // ── runtime_invoke ───────────────────────────────────────────────
  server.registerTool(
    "runtime_invoke",
    {
      description:
        "Resolve an asset's gated runtime and optionally EXECUTE it locally (LR8). Verifies the " +
        "supplied license grants 'runtimeExecution' (the LR2 flag) and, when a PoU-gated dropId + " +
        "buyer are given, that the on-chain Proof-of-Use is granted (LR3). Without 'input' it " +
        "returns the agent's runtime manifest pointer (the agent-card CID carrying modelConfig / " +
        "systemPrompt / toolsSchema / skillCID). With 'input', it fetches the skillCID bundle from " +
        "IPFS and runs it on the local model, returning the produced output. Skill bundles are " +
        "declarative manifests (model + prompt + tools), never executable code.",
      inputSchema: {
        agentId: z
          .string()
          .describe("The ERC-8004 agentId whose runtime manifest to resolve."),
        input: z
          .string()
          .optional()
          .describe(
            "User input to run the skill against. When provided, the skillCID bundle is fetched " +
              "and executed locally; when omitted, only the runtime manifest pointer is returned.",
          ),
        dropId: z
          .string()
          .optional()
          .describe("Drop id of the purchased asset, used to verify Proof-of-Use when gated."),
        buyer: z
          .string()
          .optional()
          .describe("Buyer address whose Proof-of-Use grant is checked for a PoU-gated drop."),
        spdx: z
          .string()
          .optional()
          .describe("A plain SPDX license string. Mutually exclusive with terms."),
        terms: z
          .object({
            commercial: z.boolean().optional(),
            derivative: z.boolean().optional(),
            runtimeExecution: z.boolean().optional(),
            expiry: z.string().nullable().optional(),
          })
          .passthrough()
          .optional()
          .describe("A structured license terms object granting runtimeExecution."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        const license = normalizeLicense(params.terms ?? params.spdx ?? undefined);
        const gate = checkLicense(license, "runtimeExecution");
        if (!gate.allowed) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { invoked: false, reason: gate.reason ?? "license denies runtime execution" },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const blueprint = await invokeHandler("broker:agent-blueprint", {
          chain: params.chain,
          agentId: params.agentId,
        });
        const runtime = (blueprint as { runtime?: unknown })?.runtime;
        if (!runtime) {
          throw new Error(
            `agent ${params.agentId} exposes no runtime manifest (no agent-card CID on its identity)`,
          );
        }

        // LR8: when an input is supplied, fetch the skillCID bundle from IPFS and
        // run it locally behind the same license gate (plus on-chain PoU if the
        // drop requires it). Otherwise keep the manifest-only behaviour (LR5).
        if (typeof params.input === "string") {
          const chain = (params.chain as GlueChainId) ?? DEFAULT_GLUE_CHAIN;
          const result = await invokeAndMeter({
            chain,
            agentId: params.agentId,
            input: params.input,
            license,
            dropId: params.dropId,
            buyer: params.buyer,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    invoked: true,
                    executionMode:
                      result.kind === "tool-agent"
                        ? "local-ipld tool-agent (LR9)"
                        : result.kind === "code-agent"
                          ? "local-ipld code-agent (LR10)"
                          : "local-ipld prompt-agent (LR8)",
                    skillKind: result.kind,
                    steps: result.steps,
                    agentId: result.agentId,
                    skillCid: result.skillCid,
                    modelId: result.modelId,
                    finishReason: result.finishReason,
                    usage: result.usage,
                    metering: {
                      durationMs: result.durationMs,
                      startedAt: result.startedAt,
                      finishedAt: result.finishedAt,
                    },
                    output: result.output,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  invoked: true,
                  executionMode: "manifest-only (LR5; supply 'input' to execute locally via LR8)",
                  runtime,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error invoking runtime: ${err.message}` }],
        };
      }
    },
  );

  // ── skill_publish ────────────────────────────────────────────────
  server.registerTool(
    "skill_publish",
    {
      description:
        "Author a runnable skill bundle, pin it to IPFS, attach its CID to the agent's card " +
        "(skillCID), re-pin the card, and update the ERC-8004 agentDomain to the new card (LR11). " +
        "After this, runtime_invoke can execute the skill end to end. The skill 'kind' selects the " +
        "runtime: 'prompt-agent' (single prompt), 'tool-agent' (multi-step MCP tool calling), or " +
        "'code-agent' (sandboxed JavaScript). Uses the local signing wallet (must control the agent).",
      inputSchema: {
        agentId: z.string().describe("ERC-8004 agentId whose card the skill is attached to."),
        kind: z
          .enum(["prompt-agent", "tool-agent", "code-agent"])
          .describe("Runtime kind for the skill bundle."),
        modelId: z
          .string()
          .optional()
          .describe("Model id (required for prompt-agent / tool-agent)."),
        systemPrompt: z
          .string()
          .optional()
          .describe("System prompt (required for prompt-agent / tool-agent)."),
        promptTemplate: z
          .string()
          .optional()
          .describe("Optional user-prompt template; '{{input}}' is replaced with the runtime input."),
        tools: z
          .array(z.string())
          .optional()
          .describe("tool-agent only: allow-list of fully-qualified MCP tool names (mcp__server__tool)."),
        maxSteps: z.number().optional().describe("tool-agent only: max reasoning/tool-call steps."),
        code: z.string().optional().describe("code-agent only: JavaScript source executed in the sandbox."),
        allowedModules: z
          .array(z.string())
          .optional()
          .describe("code-agent only: modules the code may require() (deny-all by default)."),
        timeoutMs: z.number().optional().describe("code-agent only: execution timeout (ms)."),
        maxMemoryMb: z.number().optional().describe("code-agent only: worker heap cap (MiB)."),
        cardName: z
          .string()
          .optional()
          .describe("Name for a freshly-built card when the agent has none yet."),
        chain: z.string().optional().describe(CHAIN_DESC),
      },
    },
    async (params) => {
      try {
        let skill: Record<string, unknown>;
        if (params.kind === "code-agent") {
          if (!params.code) throw new Error("code is required for a code-agent skill");
          skill = {
            kind: "code-agent",
            code: params.code,
            allowedModules: params.allowedModules,
            timeoutMs: params.timeoutMs,
            maxMemoryMb: params.maxMemoryMb,
          };
        } else {
          if (!params.modelId) throw new Error("modelId is required for this skill kind");
          if (!params.systemPrompt) throw new Error("systemPrompt is required for this skill kind");
          skill = {
            kind: params.kind,
            modelId: params.modelId,
            systemPrompt: params.systemPrompt,
            promptTemplate: params.promptTemplate,
          };
          if (params.kind === "tool-agent") {
            if (!params.tools || params.tools.length === 0) {
              throw new Error("tools allow-list is required for a tool-agent skill");
            }
            skill.tools = params.tools;
            skill.maxSteps = params.maxSteps;
          }
        }
        const result = await invokeHandler("erc8004:publish-skill", {
          chain: params.chain,
          agentId: params.agentId,
          skill,
          cardName: params.cardName,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error publishing skill: ${err.message}` }],
        };
      }
    },
  );
}
