/**
 * Ambient declaration for the optional Lit Protocol SDK.
 *
 * The SDK is intentionally NOT a package.json dependency — it is loaded
 * lazily via dynamic import in src/lib/tee/attestation_provider.ts and
 * src/lib/onchain/lit_relayer.ts only when Lit is configured
 * (JOY_LIT_NETWORK / JOY_LIT_PKP_PUBKEY / JOY_LIT_ACTION_CID). Both call
 * sites treat the module as `unknown` and validate its exports at runtime.
 */
declare module "@lit-protocol/lit-node-client";
