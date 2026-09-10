# WhatsApp as a JoyCreate channel

The OpenClaw gateway config already reserves a slot for WhatsApp
(`whatsapp: ["sessionId"]`, `openclaw_gateway_service.ts`), and `whatsapp` is a
value in the `channel` enum on the message tables. No service module exists, and
this document explains why that is a deliberate pause rather than an oversight.

Discord and Telegram were straightforward: both offer an official, documented
bot API that a desktop application can hold a **client-side** connection to —
Discord over a Gateway WebSocket, Telegram over long-polling. Neither needs an
inbound network path, which is what makes them viable in an app running on
someone's laptop behind NAT.

WhatsApp offers no equivalent. There are two routes and both have a real cost.

## Route 1 — WhatsApp Business Cloud API (official)

Meta's supported path. Stable, documented, and it will not get an account banned.

**Why it does not fit today:** it is webhook-only for inbound messages. Meta
delivers each message by POSTing to a public HTTPS URL you control. A desktop app
has no public URL, so this requires one of:

- a tunnel (ngrok, Cloudflare Tunnel) running alongside JoyCreate, which the user
  must install, authenticate and keep alive; or
- a relay server you host, which then sees every message — squarely against the
  local-first position the rest of the app takes.

It also needs a Meta developer app, a Business account, and a dedicated phone
number that is not already registered to the normal WhatsApp app. Outbound
messages to a user are restricted to a 24-hour window after their last message
unless you use pre-approved message templates.

**When to revisit:** if JoyCreate ever gains a first-party relay or a bundled
tunnel, this becomes the obvious choice and should be taken.

## Route 2 — Unofficial Web client library (Baileys and similar)

Reverse-engineered implementations of the WhatsApp Web protocol. They pair by QR
code from your normal WhatsApp account, keep a session on disk, and need no
public URL — which is exactly the shape that would fit here.

**Why it is not being taken:**

- It is not a supported API. It breaks whenever WhatsApp changes the protocol,
  and it breaks without warning, in the field, on users' machines.
- Meta's terms prohibit unofficial clients. The realistic consequence is the
  paired **phone number being banned** — not a test account, the user's actual
  WhatsApp number.
- The session credential on disk is equivalent to a logged-in WhatsApp session.
  That is a materially heavier secret than a revocable bot token, and it would
  need to sit in the vault rather than in a config file.

Shipping this by default would mean shipping a feature that can get a user's
personal phone number banned. That is not a trade to make on their behalf.

## Where this leaves the config slot

`whatsapp: ["sessionId"]` stays. It costs nothing, it keeps the daemon's config
hardening correct for anyone whose external OpenClaw daemon *does* run WhatsApp,
and it means the ownership arbiter already has the right shape if a service is
added later.

If you want WhatsApp today, the supported answer is to run it in the external
OpenClaw daemon and let JoyCreate bridge to it — the daemon is a separate
process with its own risk posture, and the channel-ownership logic in
`src/lib/channels/channel_owner.ts` already knows how to defer to it.

## If we do build it

Follow the shape the other two channels use, so the arbiter, the autostart and
the Channels UI need no special cases:

- `src/lib/whatsapp_bot_service.ts` implementing the same surface as
  `discord_bot_service`: `configure, validateToken, start, stop, getStatus,
  getConfig, isConfigured, sendMessage`
- `src/ipc/handlers/whatsapp_handlers.ts` registering the same seven channels,
  added to the preload allowlist and `ipc_client`
- the QR pairing step surfaced in the Channels tab, since it is interactive in a
  way a token field is not
- the session blob stored through the vault, not `openclaw.json`
