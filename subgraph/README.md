# JOY Marketplace Subgraph (LR6 / G6)

Goldsky subgraph that indexes the ERC-8004 identity/reputation registries and
the Arbitrum Stylus "glue" contracts (StoreRegistry, EditionController,
AgentMandate) so the interface broker and marketplace UI can read discovery data
fast instead of scanning chain logs over RPC.

## Indexed contracts (Arbitrum Sepolia)

| Contract           | Address                                      | Events |
|--------------------|----------------------------------------------|--------|
| IdentityRegistry   | `0x2168a88e613cd28409335eaa98e8aeed78d2e2ec` | `AgentRegistered`, `AgentUpdated` |
| ReputationRegistry | `0x82718a9325ee5322cab83d5b7ee4ed060c19a626` | `FeedbackSubmitted`, `AuthFeedback` |
| StoreRegistry      | `0x2e6f02271ae08250d2c87f4fa02eb468f4abe3e4` | `StoreRegistered`, `StoreAgentUpdated`, `StoreTransferred` |
| EditionController  | `0x93b334ce8043195d57259c55ca2b336e63c17255` | `DropCreated`, `DropActivated`, `ProofGranted`, `Minted` |
| AgentMandate       | `0xe326ec664c22ac6adde0215e619fe8aece669408` | `MandateCreated`, `MandateSpent`, `MandateRevoked` |

These mirror the on-chain addresses in [`src/config/glue.ts`](../src/config/glue.ts)
and [`src/config/erc8004.ts`](../src/config/erc8004.ts). The app reads the result
endpoints from [`src/config/subgraphs.ts`](../src/config/subgraphs.ts).

## ⚠️ Manual redeploy required

The Goldsky deploy **cannot be automated** from the app. After changing the
schema or mappings, a maintainer must redeploy by hand:

```sh
cd subgraph
npm install
npm run codegen
npm run build
# Authenticate once: goldsky login
npm run deploy        # goldsky subgraph deploy joy-marketplace/<version>
```

Then bump the matching URL/version in
[`src/config/subgraphs.ts`](../src/config/subgraphs.ts) (the `joy-drop-*` /
`joy-stores-*` endpoints), commit, and verify with the LR6 manual checklist.

> **Set `startBlock`** in `subgraph.yaml` to each contract's deployment block
> before deploying — `0` works but forces a full-history scan. Deployment tx
> hashes are recorded in `/memories/repo/glue-contracts-deploy.md` and
> `/memories/repo/erc8004-deploy.md`.

## Arbitrum One (LR7)

LR7 redeploys this subgraph against Arbitrum One and fills the mainnet addresses
(currently `ZERO_ADDRESS` in the configs) and the `arbitrumOne` endpoints in
`src/config/subgraphs.ts`.
