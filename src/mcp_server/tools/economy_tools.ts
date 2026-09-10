/**
 * MCP Tools — the agent economy.
 *
 * Before this module the MCP surface had 84 tools and not one of them reached
 * the economy: an agent could generate an image, build an app and publish to
 * the marketplace, but could not open an account, price its own work, hire
 * another agent, or get paid. Every one of those channels existed and was
 * reachable only from the renderer, which means only by a human clicking. An
 * economy whose participants cannot transact without a person present is not
 * an agent economy.
 *
 * The tools map onto the `a2a:` and `wallet:` channels in the order a
 * transaction actually happens:
 *
 *   principal -> listing -> quote -> hire (escrow) -> invoke -> verify (settle)
 *
 * Two things are worth knowing before spending anything:
 *
 *   - `joycreate_agent_hire` is the step that moves money. It escrows the
 *     quoted amount against the caller's budget, and it is where per-task and
 *     daily caps are enforced.
 *   - a listing whose capability has no registered executor still runs — it
 *     falls back to an echo — so `joycreate_capability_catalog` reports which
 *     capabilities are real. Check it before paying for one.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { invokeHandler, runTool } from "./invoke_handler";
import { CAPABILITY_CHANNELS } from "@/lib/a2a_capability_catalog";

const CURRENCY = z.enum(["JOY", "TIA", "USDC", "MATIC", "points"]);

export function registerEconomyTools(server: McpServer) {
  // ── Identity and budget ───────────────────────────────────────────────────

  server.registerTool(
    "joycreate_agent_principal",
    {
      description:
        "Get or create the economic identity for an agent — its DID, payout wallet " +
        "and spend caps. Idempotent: calling it twice for the same agentId returns " +
        "the same principal. Everything else in the economy is addressed by the " +
        "principalId this returns.",
      inputSchema: {
        agentId: z.number().describe("Local agents.id of the agent."),
        displayName: z.string().optional(),
        payoutWallet: z
          .string()
          .optional()
          .describe(
            "Address that receives settlements. Without it, payouts address the DID.",
          ),
        dailyCap: z
          .string()
          .optional()
          .describe(
            "Maximum total spend per UTC day, as an integer string in the smallest unit.",
          ),
        perTaskCap: z
          .string()
          .optional()
          .describe("Maximum spend on any single contract, same units as dailyCap."),
        currency: CURRENCY.optional(),
      },
    },
    async (p) =>
      runTool("joycreate_agent_principal", () =>
        invokeHandler("a2a:principal:get-or-create", {
          agentId: p.agentId,
          displayName: p.displayName,
          payoutWallet: p.payoutWallet,
          budget:
            p.dailyCap !== undefined || p.perTaskCap !== undefined
              ? {
                  dailyCap: p.dailyCap ?? "0",
                  perTaskCap: p.perTaskCap ?? "0",
                  currency: p.currency ?? "USDC",
                }
              : undefined,
        }),
      ),
  );

  server.registerTool(
    "joycreate_agent_principals",
    {
      description:
        "List every economic identity on this machine, with its caps and spend so far today.",
      inputSchema: {},
    },
    async () =>
      runTool("joycreate_agent_principals", () =>
        invokeHandler("a2a:principal:list"),
      ),
  );

  server.registerTool(
    "joycreate_agent_set_budget",
    {
      description:
        "Set an agent's spend caps. A cap of '0' blocks all spending, which is the " +
        "default a new principal starts with — a principal cannot hire anyone until " +
        "this is called. Caps are enforced at hire time, before funds are escrowed.",
      inputSchema: {
        principalId: z.string(),
        dailyCap: z.string(),
        perTaskCap: z.string(),
        currency: CURRENCY.default("USDC"),
      },
    },
    async (p) =>
      runTool("joycreate_agent_set_budget", () =>
        invokeHandler("a2a:principal:set-budget", p),
      ),
  );

  // ── Selling ───────────────────────────────────────────────────────────────

  server.registerTool(
    "joycreate_capability_catalog",
    {
      description:
        "The capabilities this machine can actually execute, and the handler each " +
        "one runs. A listing may declare any capability string, but one outside this " +
        "catalogue is served by an echo stub that returns the caller's input and " +
        "still charges them. Check here before buying.",
      inputSchema: {},
    },
    async () =>
      runTool("joycreate_capability_catalog", async () => ({
        executable: Object.entries(CAPABILITY_CHANNELS).map(
          ([capability, channel]) => ({ capability, channel }),
        ),
        note:
          "Capabilities not listed here fall back to an echo executor: the invocation " +
          "succeeds, the provider is paid, and no work is done.",
      })),
  );

  server.registerTool(
    "joycreate_capability_list",
    {
      description:
        "Offer a capability for sale. The listing is what other agents quote against. " +
        "Create it as 'draft' and set status 'active' when ready — only active listings " +
        "can be quoted.",
      inputSchema: {
        principalId: z.string().describe("The selling agent's principal."),
        name: z.string(),
        capability: z
          .string()
          .describe(
            "Capability identifier, e.g. 'image.generate'. See joycreate_capability_catalog.",
          ),
        description: z.string().optional(),
        priceAmount: z
          .string()
          .describe("Integer string in the smallest unit of `currency`."),
        currency: CURRENCY.default("USDC"),
        pricingModel: z.enum(["fixed", "per_call", "per_token"]).default("fixed"),
        maxLatencyMs: z.number().optional(),
        tags: z.array(z.string()).optional(),
        status: z.enum(["draft", "active", "paused"]).default("draft"),
      },
    },
    async (p) =>
      runTool("joycreate_capability_list", () =>
        invokeHandler("a2a:listing:create", p),
      ),
  );

  server.registerTool(
    "joycreate_capability_search",
    {
      description:
        "Find capabilities for sale. Filter by capability name, principal or status.",
      inputSchema: {
        capability: z.string().optional(),
        principalId: z.string().optional(),
        status: z.enum(["draft", "active", "paused", "retired"]).optional(),
      },
    },
    async (p) =>
      runTool("joycreate_capability_search", () =>
        invokeHandler("a2a:listing:list", p),
      ),
  );

  // ── Buying ────────────────────────────────────────────────────────────────

  server.registerTool(
    "joycreate_agent_quote",
    {
      description:
        "Ask a listing what a job would cost. The price is frozen on the quote and the " +
        "quote expires (5 minutes by default), so the seller cannot reprice underneath " +
        "the buyer. Spends nothing. Policy denials surface here rather than at hire time.",
      inputSchema: {
        listingId: z.string(),
        callerPrincipalId: z.string().describe("The buying agent's principal."),
        inputSummary: z.string().optional(),
        estimatedTokens: z
          .number()
          .optional()
          .describe("Required for per_token listings."),
        ttlMs: z.number().optional(),
      },
    },
    async (p) =>
      runTool("joycreate_agent_quote", () =>
        invokeHandler("a2a:quote:request", p),
      ),
  );

  server.registerTool(
    "joycreate_agent_hire",
    {
      description:
        "Accept a quote. THIS SPENDS MONEY: it checks the buyer's per-task and daily " +
        "caps, debits the quoted amount, escrows it, and returns a contract in state " +
        "ESCROWED. The provider is not paid until the work is verified; a failed " +
        "invocation refunds automatically.",
      inputSchema: { quoteId: z.string() },
    },
    async ({ quoteId }) =>
      runTool("joycreate_agent_hire", () =>
        invokeHandler("a2a:quote:accept", quoteId),
      ),
  );

  server.registerTool(
    "joycreate_agent_invoke",
    {
      description:
        "Run the work under an escrowed contract. The listing's capability decides which " +
        "handler executes. Leaves the contract DELIVERED on success and FAILED — with the " +
        "escrow refunded — on error.",
      inputSchema: {
        contractId: z.string(),
        input: z
          .record(z.any())
          .optional()
          .describe("Passed to the capability's handler verbatim."),
      },
    },
    async (p) =>
      runTool("joycreate_agent_invoke", () => invokeHandler("a2a:invoke", p)),
  );

  server.registerTool(
    "joycreate_agent_verify",
    {
      description:
        "Settle or reject delivered work. 'accept' pays the provider out of escrow and " +
        "updates their reputation. 'reject' fails the contract and refunds the buyer. " +
        "Until this is called the money sits in escrow and nobody has it.",
      inputSchema: {
        invocationId: z.string(),
        verdict: z.enum(["accept", "reject"]),
        note: z.string().optional(),
      },
    },
    async (p) =>
      runTool("joycreate_agent_verify", () =>
        invokeHandler("a2a:invocation:verify", p),
      ),
  );

  // ── Inspection ────────────────────────────────────────────────────────────

  server.registerTool(
    "joycreate_agent_contracts",
    {
      description:
        "List contracts, optionally filtered by principal or state. Use it to find work " +
        "waiting to be invoked (ESCROWED) or verified (DELIVERED).",
      inputSchema: {
        callerPrincipalId: z.string().optional(),
        providerPrincipalId: z.string().optional(),
        state: z
          .enum([
            "ACCEPTED",
            "ESCROWED",
            "IN_PROGRESS",
            "DELIVERED",
            "VERIFIED",
            "SETTLED",
            "FAILED",
            "DISPUTED",
            "REFUNDED",
            "CLOSED",
          ])
          .optional(),
      },
    },
    async (p) =>
      runTool("joycreate_agent_contracts", () =>
        invokeHandler("a2a:contract:list", p),
      ),
  );

  server.registerTool(
    "joycreate_agent_invocations",
    {
      description:
        "List the invocations run under a contract, with their output and timings.",
      inputSchema: { contractId: z.string() },
    },
    async ({ contractId }) =>
      runTool("joycreate_agent_invocations", () =>
        invokeHandler("a2a:invocation:list", contractId),
      ),
  );

  server.registerTool(
    "joycreate_agent_refund",
    {
      description:
        "Return an escrow to the buyer. Only reachable from ESCROWED, FAILED or DISPUTED — " +
        "settled work cannot be clawed back. Idempotent: a second call will not credit twice.",
      inputSchema: { contractId: z.string(), note: z.string().optional() },
    },
    async (p) =>
      runTool("joycreate_agent_refund", () =>
        invokeHandler("a2a:contract:refund", p),
      ),
  );

  // ── Policy ────────────────────────────────────────────────────────────────

  server.registerTool(
    "joycreate_agent_policy_create",
    {
      description:
        "Constrain what an agent may do. 'deny_capability' wins over everything; adding any " +
        "'allow_capability' rule flips that principal to default-deny; 'spend_limit' caps " +
        "committed spend in a rolling window; 'require_human_verify' flags a call for review.",
      inputSchema: {
        principalId: z.string(),
        name: z.string(),
        ruleType: z.enum([
          "allow_capability",
          "deny_capability",
          "spend_limit",
          "time_window",
          "require_human_verify",
        ]),
        pattern: z
          .string()
          .optional()
          .describe("Capability glob, e.g. 'a2a.*'. Defaults to '*'."),
        maxAmount: z.string().optional().describe("spend_limit only."),
        currency: CURRENCY.optional(),
        windowSeconds: z
          .number()
          .optional()
          .describe("spend_limit window. Defaults to 86400."),
        priority: z.number().optional(),
      },
    },
    async (p) =>
      runTool("joycreate_agent_policy_create", () =>
        invokeHandler("wallet:policy:create", p),
      ),
  );

  server.registerTool(
    "joycreate_agent_policy_list",
    {
      description: "List the policies bound to a principal.",
      inputSchema: {
        principalId: z.string().optional(),
        status: z.enum(["active", "disabled"]).optional(),
      },
    },
    async (p) =>
      runTool("joycreate_agent_policy_list", () =>
        invokeHandler("wallet:policy:list", p),
      ),
  );

  server.registerTool(
    "joycreate_agent_policy_evaluate",
    {
      description:
        "Ask whether a principal may perform a capability, optionally for a given amount, " +
        "without performing it. Returns { allowed, reasons, requiresHumanVerify }.",
      inputSchema: {
        principalId: z.string(),
        capability: z.string(),
        amount: z.string().optional(),
        currency: CURRENCY.optional(),
      },
    },
    async (p) =>
      runTool("joycreate_agent_policy_evaluate", () =>
        invokeHandler("wallet:policy:evaluate", p),
      ),
  );

  server.registerTool(
    "joycreate_agent_earnings",
    {
      description: "Settlement summary across agent rentals and subscriptions.",
      inputSchema: {},
    },
    async () =>
      runTool("joycreate_agent_earnings", () => invokeHandler("earnings:summary")),
  );
}
