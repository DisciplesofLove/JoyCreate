# Using an AI subscription instead of an API key

JoyCreate historically asked for an API key for every model provider. An API key
is metered credit billed per token — but most people don't buy AI that way. They
pay a flat monthly fee: Claude Pro or Max, ChatGPT Plus or Pro, Google AI Pro,
GitHub Copilot. Before this, a Max subscriber had to buy API credit on top of the
plan they were already paying for.

Settings → **Use your AI subscription** now covers that case.

## How it works

Each vendor ships a command-line agent that performs an OAuth login and then
holds and refreshes the token itself. That is the same mechanism Claude Code and
the VS Code extensions use. JoyCreate does what an editor does: finds the CLI,
spawns it headless, and reads its output.

```
model picker ─→ get_model_client ─→ createSubscriptionCliLanguageModel
                                      └─ spawn `claude -p …` / `codex exec …`
                                         (the CLI supplies its own auth)
```

They register as ordinary `LanguageModelV2` providers, so chat streaming, agents,
and the Discord/Telegram bots get subscription models without knowing a
subprocess is involved.

| Provider | Plan it uses | CLI | Install |
|---|---|---|---|
| Claude (subscription) | Claude Pro / Max | `claude` | `npm i -g @anthropic-ai/claude-code` |
| ChatGPT (subscription) | ChatGPT Plus / Pro / Business | `codex` | `npm i -g @openai/codex` |
| Gemini (subscription) | Google AI Pro / Ultra, or the free tier | `gemini` | `npm i -g @google/gemini-cli` |
| GitHub Copilot | Copilot Free / Pro / Pro+ / Business | `copilot` | `npm i -g @github/copilot` |

Install the CLI, sign in once in a terminal, press **Re-scan**. The models appear
in the picker.

## Two rules the implementation follows

**We never read the credential files.** `~/.claude/.credentials.json`,
`~/.codex/auth.json` and their equivalents belong to the CLI. The detector checks
whether a path *exists*, to show "not signed in" usefully; it never opens one.
Lifting a token out of one of those files and replaying it against a private
endpoint is how integrations get accounts banned.

**API keys are stripped from the child environment.** `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` and friends are deleted before spawning. If a key is exported in
the parent process — and in this app one usually is — the CLI would silently
prefer it, and a request the user asked to bill to their subscription would
quietly spend metered credit instead.

## What "connected" means

The panel distinguishes three things, and only the third is proof:

- **Installed** — a binary was found. Filesystem check.
- **Signed in** — the login-created credential path exists. Filesystem check; the
  token behind it may be expired.
- **Test passed** — a real prompt went through and came back. This is the only
  state that shows a green result, because a valid login that is out of quota
  looks identical to a working one until you actually ask it something.

When a run fails, the CLI's own stderr is shown verbatim rather than a message we
invented. It is the thing that knows whether the session expired, the plan hit
its limit, or the model name was wrong.

## Limitations

- **No function calling.** These CLIs run their own tool loop and don't expose
  one. A caller that needs tools gets an `unsupported-tool` warning and should
  use an API-key provider. This is why the API-key path is not going away.
- **Sampling settings are ignored.** `temperature`, `topP` and the rest aren't
  exposed on the headless interfaces, so passing them through would be a lie;
  they surface as `unsupported-setting` warnings.
- **Latency is higher.** Each request is a process spawn, and the CLI does its
  own startup work. Fine for chat, wrong for a tight loop.
- **Quota is shared with your editor.** These requests count against the same
  plan limits as Claude Code or Copilot in VS Code.
- **Flags change between CLI versions.** Everything version-specific lives in one
  table in `src/lib/subscription_cli/cli_registry.ts` — argv, parser, search
  paths — so a vendor changing a flag is a one-line edit there.

## DeepSeek

DeepSeek has no subscription tier to attach: the web chat is free and the API is
pay-as-you-go, with no CLI that signs in against a plan. Two working routes:

- **OpenRouter** — `deepseek/deepseek-chat-v3.1` is already in the model list.
- **Custom provider** — add an OpenAI-compatible provider with base URL
  `https://api.deepseek.com/v1` and a DeepSeek API key.

Both are metered. That's DeepSeek's model, not a gap in JoyCreate.

## Files

| Path | Role |
|---|---|
| `src/lib/subscription_cli/cli_registry.ts` | Leaf module: argv, parsers, search paths, models |
| `src/lib/subscription_cli/cli_detector.ts` | Finds binaries beyond `PATH`; reports install/login state |
| `src/lib/subscription_cli/cli_runner.ts` | Spawns, streams stdout, strips billing env vars |
| `src/ipc/utils/subscription_cli_provider.ts` | `LanguageModelV2` adapter |
| `src/ipc/handlers/subscription_cli_handlers.ts` | `subscription-cli:*` channels |
| `src/components/settings/SubscriptionCliSettings.tsx` | The Settings panel |
