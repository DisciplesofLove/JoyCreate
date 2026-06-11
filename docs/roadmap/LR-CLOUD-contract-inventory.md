# LR-CLOUD — Production Joy Marketplace Contract Inventory (Arbitrum Sepolia)

> **Critical reconciliation note.** This is a **third deployment**, distinct from
> JoyCreate's local Stylus config ([erc8004.ts](../../src/config/erc8004.ts),
> [glue.ts](../../src/config/glue.ts)). It is the **live, audited, proven**
> production stack of the cloud Joy Marketplace. Same chain (Arbitrum Sepolia,
> `421614`, `eip155:421614`), **different addresses AND different ABIs**.
>
> Captured verbatim from the user (2026-06-11) so it survives compaction.

---

## The three stacks (must not be confused)

| | (A) JoyCreate local | (B) Example brief | (C) **Cloud Joy Marketplace (live)** |
|---|---|---|---|
| Toolchain | Arbitrum **Stylus** (Rust) | generic | **solc 0.8.19** (audited ChaosChain ref) |
| Identity | `newAgent(bytes domain, addr)`, domain in bytes | `mint(to, uri)` / `tokenURI` | **ERC-721** `mint(to, agentCardURI)` / `tokenURI` holds the IPFS AgentCard CID |
| Store | `StoreRegistry.registerStore(bytes slug, uint256 agentId)` | FIFSRegistrar | **`JoyStoreRegistrar.openStore`** (atomic ENS↔identity link + agent auth) |
| Edition | `EditionController.createDrop` (PoU) | ERC-1155 Drop | **`EditionController.createEdition`** + per-edition ERC-8004 identity |
| Reputation | `submitFeedback(clientId, serverId, score, bytes)` / `averageScore` | `submitFeedback(id, score, uri)` | **`giveFeedback`/`getSummary`**, `submitEditionFeedback`/`getEditionReputation`/`getStoreReputation` (gated on `balanceOf`) |
| Splits | RevenueSplitter **80/10/10** creator/platform/protocol | owner+platform+DAO | **JoyRegistrationSplitter 50/50** platform/DAO; **edition sales 80/10/5/5** seller/compute/platform/DAO |
| NFTs | (glue) | ERC-1155 Drop | **thirdweb DropERC1155 proxy** |
| Delegation | **AgentMandate** | — | agent auth via JoyStoreRegistrar |

**Insight:** The cloud stack (C) is essentially the **brief's ERC-721/tokenURI
model, fully realized and audited** — not JoyCreate's Stylus model (A).

---

## Cloud address book (Arbitrum Sepolia)

| Contract | Address | Role |
|---|---|---|
| IdentityRegistry (ERC-8004, ERC-721) | `0x6Bb3300B81811790b1871A46CC764128a6e25964` | agent/store/edition identity; `tokenURI` = AgentCard CID |
| ReputationRegistry (ERC-8004) | `0x83615e9dE3E745804C1226D95A2Ded0b1A30Ac2C` | on-chain feedback (`giveFeedback`/`getSummary`) |
| ValidationRegistry (ERC-8004) | `0x4bBa119FDAFB5D044AF055e5b4B8739Ca7665d87` | agent validation |
| JoyStoreRegistrar | `0xAa036519ed84F7a450d5684062E79742EbEFfE57` | `openStore`; links ENS ↔ identity; agent auth |
| EditionController | `0xF3c41b1E3aE3Db0e91985cB140781Ada636AD617` | `createEdition` + reputation |
| JoyRegistrationSplitter | `0x8fe239b56698401c90038f3E286C9aFd7aD5Ec27` | 50/50 platform/DAO registration fee |
| DropERC1155 (thirdweb proxy) | `0x61672Aa9C97342183481455834e6e944Ea64e552` | the edition NFTs |
| ENSRegistry | `0xC8c72a682905e7fC02Ba4b991132df833f6faC0F` | ENS root |
| BaseRegistrar (`joymarketplace.io`) | `0x0eb35745a6fA890Da0d9364dF7f81201622eC3A8` | ENS subname issuance |
| JoyResolver | `0x8ed45d1bc39cb2d2138b668e343a1dc0aff67f60` | ENS resolution |
| JoyRegistrarController | `0xc7fe10924360459fd09528df41701f1444997ede` | ENS registration (0.01 ETH/yr) |
| USDC (Circle, EIP-3009) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | **matches JoyCreate's x402 config** |

---

## Cloud capabilities already live (do NOT rebuild)

- **Gasless USDC purchases** — buyer signs EIP-3009 `transferWithAuthorization`
  (USDC, zero ETH); **relayer pays Arbitrum gas** + claims NFT to buyer. Proven on-chain.
- **Self-facilitated x402 v2 server** — public x402.org does NOT settle Arbitrum
  Sepolia, so they built their own facilitator (verify EIP-3009 → settle via relayer).
  Network id `eip155:421614`.
- **ENS-named stores** — `<label>.joymarketplace.io`; `openStore` atomically links
  ENS node ↔ ERC-8004 identity. Proven (storeId 1).
- **Per-store + per-edition ERC-8004 identities** with on-chain reputation gated on
  edition ownership. Proven (`submitEditionFeedback(50)` reads back).
- **Revenue splits** — registration 50/50; edition sales 80/10/5/5 via relayer fan-out, all in Arbitrum USDC.
- **IPFS AgentCards** — zod-validated, pinned, CID written as `tokenURI` on the
  IdentityRegistry. `scripts/verify-agent-card.ts`. Proven (identityId 5 + 6 resolve).
- **MCP server, 7 tools** — `store_register`, `edition_create`, `edition_buy`,
  `store_reputation`, `edition_reputation`, `store_discover`, `agent_get`. All write
  tools relayer-signed on Arbitrum. Custom discovery via subgraph (global id
  `arb:421614:<agentId>`).
- **Two Goldsky subgraphs (live):** `joy-stores-arbitrum-sepolia/0.0.4`
  (agents, stores, feedback, validation, ENS) and `joy-drop-arbitrum-sepolia/0.0.5`
  (editions, purchases, ReputationScore, ReputationEvent).
- **Frontend Arbitrum-aware** — `src/config/sharedContracts.ts` address book;
  `MarketDropDetailModal.tsx` routes `chain.id === 421614` through gasless x402;
  hooks `use_open_store` / `use_buy_edition` / `use_edition_reputation` switch chain.
- **Verified quality** — Slither 0 medium+; tests JoyStoreRegistrar 26/26,
  EditionController 20/20, JoyRegistrationSplitter 11/11, x402 25/25, MCP 12/12.

### Proven Arbitrum txs (reference)
ENS register `0x99d4bb21…` · openStore (id 1) `0xb9d7dcf7…` · createEdition (tokenId 0)
`0x746e45fa…` · drop claim `0x1137eb9b…` · submitEditionFeedback(50) `0x8c846482…` ·
x402 USDC settle `0xdbddf876…` · x402 NFT claim `0x098998f6…`.

---

## Impact on the LR roadmap (the fork)

The cloud stack (C) **already implements much of LR1–LR6** — but against different
contracts/ABIs than JoyCreate's local clients
([erc8004_client.ts](../../src/lib/onchain/erc8004_client.ts),
[glue_client.ts](../../src/lib/onchain/glue_client.ts)) target.

**Open decision (blocks LR2+):** does JoyCreate
- **(C-align)** repoint its config + adapt its client ABIs to the **cloud production
  contracts** (interoperate with the live marketplace; reuse its subgraphs, x402
  facilitator, gasless relayer), **or**
- **(A-keep)** keep its own Stylus deployment and treat cloud as a separate interop
  target (bridge via the ERC-1144 blueprint)?

### RESOLVED 2026-06-11 → **A-keep + gasless relayer**

- JoyCreate **keeps its local Stylus stack** ([erc8004.ts](../../src/config/erc8004.ts),
  [glue.ts](../../src/config/glue.ts)) as canonical. The cloud stack (C) is **not**
  repointed to; it is reached via the ERC-1144 blueprint as a separate interop target.
  → **LR1 stays as-is**; LR2–LR8 proceed on Stylus.
- For **purchase settlement**, adopt the cloud's **gasless EIP-3009 relayer** model
  (buyer signs `transferWithAuthorization`, relayer pays gas + settles). Wired into
  JoyCreate's own x402 rail in LR3; cloud-minted editions may settle through the
  cloud relayer directly.

Consequences:
- **C-align** likely makes LR1's `agentDomainToCardCid` (reads Stylus `agentDomain`
  bytes) switch to reading **`tokenURI`** (ERC-721); store reg becomes `openStore`;
  drops become `createEdition`; reputation becomes `giveFeedback`/`getSummary`;
  splits become 50/50 + 80/10/5/5; LR3 reputation + LR6 subgraph + gasless x402 are
  **already done** upstream and JoyCreate just calls them.
- **A-keep** preserves the LR1 work as-is and continues LR2–LR8 on the Stylus stack,
  with the cloud stack reachable through blueprints only.

_Resolution: **A-keep + gasless relayer** (see the RESOLVED block above). LR1 is
implemented against (A) and remains valid._
