import { LanguageModel } from "../ipc_types";
import { SUBSCRIPTION_CLIS } from "../../lib/subscription_cli/cli_registry";

export const PROVIDERS_THAT_SUPPORT_THINKING: (keyof typeof MODEL_OPTIONS)[] = [
  "google",
  "vertex",
  "auto",
];

export interface ModelOption {
  name: string;
  displayName: string;
  description: string;
  dollarSigns?: number;
  temperature?: number;
  tag?: string;
  tagColor?: string;
  maxOutputTokens?: number;
  contextWindow?: number;
}

export const MODEL_OPTIONS: Record<string, ModelOption[]> = {
  openai: [
    // Verified 2026-09-15 against OpenAI's models page and OpenRouter's live
    // list. GPT-5.x Codex models were shut down on 2026-07-23.
    {
      name: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "OpenAI's flagship for complex professional and coding work",
      maxOutputTokens: undefined,
      contextWindow: 1_050_000,
      // GPT-5 reasoning models require the default temperature (1).
      temperature: 1,
      dollarSigns: 3,
      tag: "Latest",
      tagColor: "green",
    },
    {
      name: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      description: "OpenAI's most capable model, for the hardest end-to-end work",
      maxOutputTokens: undefined,
      contextWindow: 1_050_000,
      temperature: 1,
      dollarSigns: 4,
    },
    {
      name: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      description: "Balances intelligence and cost",
      maxOutputTokens: undefined,
      contextWindow: 1_050_000,
      temperature: 1,
      dollarSigns: 2,
    },
    {
      name: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      description: "Fast and low cost, for high-volume work",
      maxOutputTokens: undefined,
      contextWindow: 1_050_000,
      temperature: 1,
      dollarSigns: 1,
    },
  ],
  anthropic: [
    // Verified 2026-09-15 against Anthropic's models page. These models reject
    // non-default temperature/top_p/top_k with a 400; getModelClient strips
    // those parameters for them, so no temperature is set here.
    {
      name: "claude-opus-5",
      displayName: "Claude Opus 5",
      description: "Anthropic's recommended default for complex agentic coding and most work",
      maxOutputTokens: 32_000,
      contextWindow: 200_000,
      dollarSigns: 5,
      tag: "Latest",
      tagColor: "green",
    },
    {
      name: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      description:
        "Previous flagship Opus — complex coding & reasoning (very expensive!)",
      maxOutputTokens: 32_000,
      contextWindow: 200_000,
      temperature: 0,
      dollarSigns: 5,
    },
    {
      name: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      description:
        "Anthropic's latest Sonnet — fast, smart default for most coding tasks",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      dollarSigns: 4,
      tag: "Latest",
      tagColor: "green",
    },
    {
      name: "claude-fable-5-1",
      displayName: "Claude Fable 5.1",
      description: "Anthropic's most capable model, for demanding reasoning and long-horizon agentic work",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      dollarSigns: 5,
    },
    {
      name: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      description: "The best combination of speed and intelligence",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      dollarSigns: 3,
    },
    {
      name: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      description: "Anthropic's fastest model, with near-frontier intelligence",
      maxOutputTokens: 32_000,
      contextWindow: 200_000,
      dollarSigns: 1,
    },
  ],
  google: [
    // Verified 2026-09-15 against Google's Gemini models and pricing pages.
    // gemini-3-pro-preview is shut down.
    {
      name: "gemini-3.8-flash",
      displayName: "Gemini 3.8 Flash",
      description: "Google's most intelligent Flash model, built for coding and agents",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 1.0,
      dollarSigns: 2,
      tag: "Latest",
      tagColor: "green",
    },
    {
      name: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro (Preview)",
      description: "Google's advanced reasoning and agentic model",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 1.0,
      dollarSigns: 3,
    },
    {
      name: "gemini-3.5-flash-lite",
      displayName: "Gemini 3.5 Flash-Lite",
      description: "Google's fastest, most cost-effective model",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 1.0,
      dollarSigns: 1,
    },
    {
      name: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      description: "Previous-generation stable Pro model",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 1.0,
      dollarSigns: 3,
    },
  ],
  vertex: [
    {
      name: "gemini-3.8-flash",
      displayName: "Gemini 3.8 Flash",
      description: "Google's most intelligent Flash model, via Vertex AI",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 1.0,
    },
    {
      name: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro (Preview)",
      description: "Google's advanced reasoning model, via Vertex AI",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 1.0,
    },
    {
      name: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      description: "Previous-generation stable Pro model, via Vertex AI",
      maxOutputTokens: 65_536 - 1,
      contextWindow: 1_048_576,
      temperature: 1.0,
    },
  ],
  openrouter: [
    // Verified 2026-09-15 against OpenRouter's live model list. The previous
    // free models (qwen/qwen3-coder:free, mistralai/devstral-2512:free) no
    // longer exist, which broke the "Free (OpenRouter)" option.
    {
      name: "thinkingmachines/inkling:free",
      displayName: "Inkling (free)",
      description: "Free, tool-capable model with a 1M-token context",
      maxOutputTokens: 32_000,
      contextWindow: 1_048_576,
      temperature: 0,
      dollarSigns: 0,
    },
    {
      name: "nvidia/nemotron-3.5-lightning:free",
      displayName: "Nemotron 3.5 Lightning (free)",
      description: "Free, fast, tool-capable model with a 1M-token context",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      temperature: 0,
      dollarSigns: 0,
    },
    {
      name: "qwen/qwen3-coder-next",
      displayName: "Qwen3 Coder Next",
      description: "Qwen's latest coding model",
      maxOutputTokens: 32_000,
      contextWindow: 262_144,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "deepseek/deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      description: "DeepSeek's strongest model",
      maxOutputTokens: 32_000,
      contextWindow: 1_048_576,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "deepseek/deepseek-v4.1-flash",
      displayName: "DeepSeek V4.1 Flash",
      description: "DeepSeek's newest fast, low-cost model",
      maxOutputTokens: 32_000,
      contextWindow: 1_048_576,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "z-ai/glm-5.3",
      displayName: "GLM 5.3",
      description: "Z.ai's latest flagship",
      maxOutputTokens: 32_000,
      contextWindow: 1_310_720,
      temperature: 0,
      dollarSigns: 2,
    },
    {
      name: "moonshotai/kimi-k3",
      displayName: "Kimi K3",
      description: "Moonshot AI's latest flagship",
      maxOutputTokens: 32_000,
      contextWindow: 1_048_576,
      temperature: 0,
      dollarSigns: 3,
    },
  ],
  auto: [
    {
      name: "auto",
      displayName: "Auto",
      description: "Automatically selects the best model",
      tag: "Default",
      // The following is reasonable defaults.
      maxOutputTokens: 32_000,
      contextWindow: 200_000,
      temperature: 0,
    },
    {
      name: "free",
      displayName: "Free (OpenRouter)",
      description: "Selects from one of the free OpenRouter models",
      tag: "Free",
      // These are below Gemini 2.5 Pro & Flash limits
      // which are the ones defaulted to for both regular auto
      // and smart auto.
      maxOutputTokens: 32_000,
      contextWindow: 128_000,
      temperature: 0,
    },
    {
      name: "turbo",
      displayName: "Turbo (Pro)",
      description: "Use very fast open-source frontier models",
      maxOutputTokens: 32_000,
      contextWindow: 256_000,
      temperature: 0,
      tag: "Fast",
      tagColor: "bg-rose-800 text-white",
    },
    {
      name: "value",
      displayName: "Super Value (Pro)",
      description: "Uses the most cost-effective models available",
      maxOutputTokens: 32_000,
      contextWindow: 256_000,
      temperature: 0,
      tag: "Budget",
      tagColor: "bg-emerald-700 text-white",
    },
  ],
  azure: [
    // Azure deployment names must match these; availability per region varies.
    {
      name: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "OpenAI's flagship, via Azure OpenAI",
      contextWindow: 1_050_000,
      temperature: 1,
    },
    {
      name: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      description: "OpenAI's most capable model, via Azure OpenAI",
      contextWindow: 1_050_000,
      temperature: 1,
    },
    {
      name: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      description: "Balanced cost and capability, via Azure OpenAI",
      contextWindow: 1_050_000,
      temperature: 1,
    },
    {
      name: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      description: "Fast and low cost, via Azure OpenAI",
      contextWindow: 1_050_000,
      temperature: 1,
    },
    {
      name: "gpt-5.1",
      displayName: "GPT-5.1",
      description: "Previous generation, for existing Azure deployments",
      contextWindow: 400_000,
      temperature: 1,
    },
  ],
  xai: [
    // Verified 2026-09-15 against xAI's models page and OpenRouter's live list.
    {
      name: "grok-4.6",
      displayName: "Grok 4.6",
      description: "xAI's latest flagship",
      maxOutputTokens: 32_000,
      contextWindow: 500_000,
      temperature: 0,
      dollarSigns: 3,
      tag: "Latest",
      tagColor: "green",
    },
    {
      name: "grok-build-0.1",
      displayName: "Grok Build",
      description: "xAI's coding model",
      maxOutputTokens: 32_000,
      contextWindow: 256_000,
      temperature: 0,
      dollarSigns: 1,
    },
    {
      name: "grok-4.3",
      displayName: "Grok 4.3",
      description: "Lower cost, with a 1M-token context",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      temperature: 0,
      dollarSigns: 1,
    },
  ],
  bedrock: [
    // Bedrock IDs for the Claude 5 generation are the Messages-API IDs from
    // Anthropic's models page. Not verified against a live Bedrock account.
    {
      name: "anthropic.claude-opus-5",
      displayName: "Claude Opus 5",
      description: "Anthropic's recommended default for complex agentic coding",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
      tag: "Latest",
      tagColor: "green",
    },
    {
      name: "anthropic.claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      description: "Speed and intelligence for most coding tasks",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
    },
    {
      name: "anthropic.claude-fable-5-1",
      displayName: "Claude Fable 5.1",
      description: "Anthropic's most capable model (expensive)",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
    },
    {
      name: "us.anthropic.claude-opus-4-7-v1:0",
      displayName: "Claude Opus 4.7 (legacy)",
      description: "Previous-generation Opus",
      maxOutputTokens: 32_000,
      contextWindow: 1_000_000,
    },
  ],
};

export const TURBO_MODELS: LanguageModel[] = [
  {
    apiName: "glm-4.6:turbo",
    displayName: "GLM 4.6",
    description: "Strong coding model (very fast)",
    maxOutputTokens: 32_000,
    contextWindow: 131_000,
    temperature: 0,
    dollarSigns: 3,
    type: "cloud",
  },
  {
    apiName: "kimi-k2:turbo",
    displayName: "Kimi K2",
    description: "Kimi 0905 update (fast)",
    maxOutputTokens: 16_000,
    contextWindow: 256_000,
    temperature: 0,
    dollarSigns: 2,
    type: "cloud",
  },
];

export const FREE_OPENROUTER_MODEL_NAMES = MODEL_OPTIONS.openrouter
  .filter((model) => model.name.endsWith(":free"))
  .map((model) => model.name);

export const PROVIDER_TO_ENV_VAR: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  azure: "AZURE_API_KEY",
  xai: "XAI_API_KEY",
  bedrock: "AWS_BEARER_TOKEN_BEDROCK",
};

export const CLOUD_PROVIDERS: Record<
  string,
  {
    displayName: string;
    hasFreeTier?: boolean;
    websiteUrl?: string;
    gatewayPrefix: string;
    secondary?: boolean;
  }
> = {
  openai: {
    displayName: "OpenAI",
    hasFreeTier: false,
    websiteUrl: "https://platform.openai.com/api-keys",
    gatewayPrefix: "",
  },
  anthropic: {
    displayName: "Anthropic",
    hasFreeTier: false,
    websiteUrl: "https://console.anthropic.com/settings/keys",
    gatewayPrefix: "anthropic/",
  },
  google: {
    displayName: "Google",
    hasFreeTier: true,
    websiteUrl: "https://aistudio.google.com/app/apikey",
    gatewayPrefix: "gemini/",
  },
  vertex: {
    displayName: "Google Vertex AI",
    hasFreeTier: false,
    websiteUrl: "https://console.cloud.google.com/vertex-ai",
    // Use the same gateway prefix as Google Gemini for JoyCreate Pro compatibility.
    gatewayPrefix: "gemini/",
    secondary: true,
  },
  openrouter: {
    displayName: "OpenRouter",
    hasFreeTier: true,
    websiteUrl: "https://openrouter.ai/settings/keys",
    gatewayPrefix: "openrouter/",
  },
  auto: {
    displayName: "JoyCreate",
    websiteUrl: "https://joycreate.ai/settings",
    gatewayPrefix: "joycreate/",
  },
  azure: {
    displayName: "Azure OpenAI",
    hasFreeTier: false,
    websiteUrl: "https://portal.azure.com/",
    gatewayPrefix: "",
    secondary: true,
  },
  xai: {
    displayName: "xAI",
    hasFreeTier: false,
    websiteUrl: "https://console.x.ai/",
    gatewayPrefix: "xai/",
    secondary: true,
  },
  bedrock: {
    displayName: "AWS Bedrock",
    hasFreeTier: false,
    websiteUrl: "https://console.aws.amazon.com/bedrock/",
    gatewayPrefix: "bedrock/",
    secondary: true,
  },
};

export const LOCAL_PROVIDERS: Record<
  string,
  {
    displayName: string;
    hasFreeTier: boolean;
  }
> = {
  ollama: {
    displayName: "Ollama",
    hasFreeTier: true,
  },
  lmstudio: {
    displayName: "LM Studio",
    hasFreeTier: true,
  },
  "genius-core": {
    displayName: "Genius Core",
    hasFreeTier: true,
  },
  OpenClaw: {
    displayName: "OpenClaw Gateway",
    hasFreeTier: true,
  },
};

// Claude Code integration for agentic coding tasks
export const CLAUDE_CODE_PROVIDER = {
  id: "claude-code",
  displayName: "Claude Code",
  description: "Agentic coding assistant with file operations",
  capabilities: ["code", "agentic", "function-calling", "reasoning"],
  requiresAnthropicKey: true,
  gatewayUrl: "ws://127.0.0.1:18792",
};

// ─── Subscription-backed CLI providers ──────────────────────────────────────
//
// Claude Pro/Max, ChatGPT Plus/Pro, Google AI Pro and GitHub Copilot are flat
// monthly plans, not metered API credit. Each vendor ships a command-line agent
// that signs in with the subscription and refreshes its own token — the same
// mechanism the editors use. JoyCreate spawns those, so a subscriber can use
// the plan they already pay for instead of buying API keys twice.
//
// They register as `local` providers because that is what they are: a process on
// this machine. There is no API key to enter, so the usual key-configuration UI
// does not apply to them; SubscriptionCliSettings handles them instead.

export const SUBSCRIPTION_PROVIDERS: Record<
  string,
  { displayName: string; hasFreeTier: boolean; websiteUrl: string }
> = Object.fromEntries(
  SUBSCRIPTION_CLIS.map((cli) => [
    cli.id,
    {
      displayName: cli.label,
      // Free only in the sense that no per-token charge lands: the plan is paid
      // for separately, and a request still consumes its quota.
      hasFreeTier: false,
      websiteUrl: cli.docsUrl,
    },
  ]),
);

/** Model picker entries for each subscription CLI. */
export const SUBSCRIPTION_MODEL_OPTIONS: Record<string, ModelOption[]> =
  Object.fromEntries(
    SUBSCRIPTION_CLIS.map((cli) => [
      cli.id,
      cli.models.map((model) => ({
        name: model.id,
        displayName: model.label,
        description: model.description,
        tag: "Subscription",
        tagColor: "emerald",
      })),
    ]),
  );

for (const [providerId, options] of Object.entries(SUBSCRIPTION_MODEL_OPTIONS)) {
  MODEL_OPTIONS[providerId] = options;
}
