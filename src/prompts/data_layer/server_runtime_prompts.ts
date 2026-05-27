/**
 * Server runtime prompts for the Data + Backend Layer.
 *
 * "Server runtime" answers: where do background jobs, cron, webhooks, and
 * server-only secrets live? This is orthogonal to the primary store —
 * an app may use Supabase storage with Cloudflare Workers as the runtime.
 */

import type { ServerRuntimeKind } from "@/shared/data_layer_types";

export const SERVER_NONE_PROMPT = `
# Server Runtime: None (client-only)

This app has no backend server runtime. All logic runs in the browser/Electron renderer.

DO NOT:
- Generate API routes, server actions, or edge functions.
- Reference \`process.env\` for secrets — there is no secure server to hold them.
- Suggest cron jobs, webhooks, or background workers.

If the user asks for any of these, suggest enabling a runtime:
<joy-add-integration provider="supabase-edge"></joy-add-integration> (if Supabase is the primary store)
<joy-add-integration provider="cloudflare-workers"></joy-add-integration> (provider-neutral edge)
<joy-add-integration provider="railway"></joy-add-integration> (long-running containers)
`;

export const SUPABASE_EDGE_AVAILABLE_PROMPT = `
# Server Runtime: Supabase Edge Functions

Server-side logic runs as **Deno** edge functions in \`supabase/functions/<name>/index.ts\`.

## Patterns
- One folder per function. Entry is \`Deno.serve(handler)\`.
- Access the project's secrets via \`Deno.env.get("KEY")\` — never inline.
- Use \`createClient\` from \`@supabase/supabase-js\` with the **service role key** for privileged operations; with the **anon key + Authorization header** to act as the calling user.
- Use \`<joy-edge-function name="...">\` to scaffold; \`<joy-deploy-edge-function name="...">\` to ship.

## Cron / webhooks
- Cron: define in \`supabase/functions/_cron.json\` (Supabase scheduled triggers).
- Webhooks: each function exposes a public URL — wire third-party providers to it.

DO NOT mix Node-only APIs (e.g. \`fs\`, \`child_process\`). This is Deno.
`;

export const SUPABASE_EDGE_NOT_AVAILABLE_PROMPT = `
If the user needs cron, webhooks, or server-only secrets, show:
<joy-add-integration provider="supabase-edge"></joy-add-integration>
`;

export const VERCEL_FUNCTIONS_AVAILABLE_PROMPT = `
# Server Runtime: Vercel Functions

Server-side logic runs as **Vercel Functions** at \`api/*.ts\` (or \`app/api/*/route.ts\` for Next.js).

## Patterns
- Default to \`export const runtime = "edge"\` for low-latency endpoints; use \`"nodejs"\` only for libraries that need Node APIs.
- Secrets via \`process.env\` configured in the Vercel dashboard or \`vercel.json\`.
- Use \`<joy-vercel-function path="/api/...">\` to scaffold an endpoint.

## Cron
- Define in \`vercel.json\` under \`crons\`. Cron endpoints must be GET handlers under \`/api/cron/\`.

DO NOT assume persistent in-memory state between invocations.
`;

export const VERCEL_FUNCTIONS_NOT_AVAILABLE_PROMPT = `
If the user needs API routes, cron, or webhooks and the app is deploying to Vercel, show:
<joy-add-integration provider="vercel-functions"></joy-add-integration>
`;

export const CLOUDFLARE_WORKERS_AVAILABLE_PROMPT = `
# Server Runtime: Cloudflare Workers

Server-side logic runs as **Cloudflare Workers** (V8 isolates, web-standards runtime).

## Patterns
- Entry at \`workers/<name>/index.ts\` exporting \`{ fetch, scheduled? }\`.
- Config in \`wrangler.toml\`. Secrets via \`wrangler secret put\`.
- Storage primitives: KV, R2 (S3-compatible), D1 (SQLite), Durable Objects (consistent state).
- Use \`<joy-cloudflare-worker name="...">\` to scaffold.

## When to choose
Best default for web3 / serverless workloads — global edge, generous free tier, web-standards \`Request\`/\`Response\`.

DO NOT use Node-only APIs unless \`nodejs_compat\` is enabled in \`wrangler.toml\`.
`;

export const CLOUDFLARE_WORKERS_NOT_AVAILABLE_PROMPT = `
If the user needs a provider-neutral edge runtime, show:
<joy-add-integration provider="cloudflare-workers"></joy-add-integration>
`;

export const RAILWAY_AVAILABLE_PROMPT = `
# Server Runtime: Railway (long-running containers)

Server-side logic runs as a **Railway service** — full Node.js container, persistent connections, websockets supported.

## Patterns
- Service entry at \`server/index.ts\`. Framework: Hono / Express / Fastify — Hono recommended (smaller, edge-portable).
- Secrets via Railway dashboard, exposed as \`process.env\`.
- Use \`<joy-railway-service name="...">\` to scaffold; deploys via \`railway.json\`.

## When to choose
- Long-running websocket / SSE servers (agent runtimes, chat backends).
- Heavy native dependencies (Puppeteer, ffmpeg).
- Stateful in-memory caches.

For short request/response APIs, prefer Cloudflare Workers or Vercel Functions.
`;

export const RAILWAY_NOT_AVAILABLE_PROMPT = `
If the user needs long-running servers, websockets, or heavy native deps, show:
<joy-add-integration provider="railway"></joy-add-integration>
`;

export const RENDER_AVAILABLE_PROMPT = `
# Server Runtime: Render (long-running containers)

Server-side logic runs as a **Render service**. Similar to Railway — full Node container, websockets, background workers.

## Patterns
- Service entry at \`server/index.ts\`. Hono recommended.
- Config in \`render.yaml\` (background workers, cron jobs, services).
- Secrets via Render dashboard → \`process.env\`.

## When to choose
Same use cases as Railway. Pick based on the user's existing account / pricing preference.
`;

export const RENDER_NOT_AVAILABLE_PROMPT = `
If the user prefers Render for hosting long-running services, show:
<joy-add-integration provider="render"></joy-add-integration>
`;

export const FLY_AVAILABLE_PROMPT = `
# Server Runtime: Fly.io (edge containers, multi-region)

Server-side logic runs as **Fly Machines** — full Docker containers placed at edge regions.

## Patterns
- App config in \`fly.toml\`. Dockerfile at repo root.
- Secrets via \`fly secrets set\` → \`process.env\`.
- Multi-region deploys for global low latency.

## When to choose
- Need full container control + global edge presence.
- Stateful workloads with persistent volumes.
- LiteFS for distributed SQLite at the edge.
`;

export const FLY_NOT_AVAILABLE_PROMPT = `
If the user wants global multi-region edge containers, show:
<joy-add-integration provider="fly-io"></joy-add-integration>
`;

export const AWS_LAMBDA_AVAILABLE_PROMPT = `
# Server Runtime: AWS Lambda

Server-side logic runs as **AWS Lambda functions** behind API Gateway or Function URLs.

## Patterns
- Use AWS SAM or SST. Entry \`handler(event, context)\`.
- Secrets via Lambda env vars or AWS Secrets Manager.
- Cold starts matter — keep bundles small; prefer ARM (Graviton) runtimes.

## When to choose
- Enterprise / existing AWS footprint.
- Need fine-grained IAM integration with other AWS services.

For greenfield apps, Cloudflare Workers or Vercel are usually simpler.
`;

export const AWS_LAMBDA_NOT_AVAILABLE_PROMPT = `
If the user needs AWS-native serverless, show:
<joy-add-integration provider="aws-lambda"></joy-add-integration>
`;

export function serverRuntimePrompt(kind: ServerRuntimeKind, configured: boolean): string {
  if (kind === "none") return SERVER_NONE_PROMPT;
  if (configured) {
    switch (kind) {
      case "supabase-edge":
        return SUPABASE_EDGE_AVAILABLE_PROMPT;
      case "vercel-functions":
        return VERCEL_FUNCTIONS_AVAILABLE_PROMPT;
      case "cloudflare-workers":
        return CLOUDFLARE_WORKERS_AVAILABLE_PROMPT;
      case "railway":
        return RAILWAY_AVAILABLE_PROMPT;
      case "render":
        return RENDER_AVAILABLE_PROMPT;
      case "fly-io":
        return FLY_AVAILABLE_PROMPT;
      case "aws-lambda":
        return AWS_LAMBDA_AVAILABLE_PROMPT;
    }
  }
  switch (kind) {
    case "supabase-edge":
      return SUPABASE_EDGE_NOT_AVAILABLE_PROMPT;
    case "vercel-functions":
      return VERCEL_FUNCTIONS_NOT_AVAILABLE_PROMPT;
    case "cloudflare-workers":
      return CLOUDFLARE_WORKERS_NOT_AVAILABLE_PROMPT;
    case "railway":
      return RAILWAY_NOT_AVAILABLE_PROMPT;
    case "render":
      return RENDER_NOT_AVAILABLE_PROMPT;
    case "fly-io":
      return FLY_NOT_AVAILABLE_PROMPT;
    case "aws-lambda":
      return AWS_LAMBDA_NOT_AVAILABLE_PROMPT;
  }
}
