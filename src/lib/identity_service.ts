/**
 * IdentityService — backing store for the Unified Identity hub.
 *
 * Local-first, single-user. Persists `UniversalIdentity` blobs (and ENS/JNS
 * record arrays) as JSON columns in SQLite to avoid migrating the 50+ field
 * shape defined in `src/types/unified_identity_types.ts`.
 *
 * DIDs are generated as `did:key:` from a fresh ed25519 keypair using the
 * Node built-in `crypto` module — no additional dependencies required.
 * Public-key bytes are multibase-encoded (z + base58btc, multicodec 0xed01)
 * per the did:key spec.
 */
import { eq } from "drizzle-orm";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { db } from "../db";
import {
  unifiedIdentities,
  unifiedIdentityEvents,
} from "../db/schema";
import type {
  CreateIdentityParams,
  IdentityEvent,
  IdentityEventType,
  JNSRegistration,
  NameServiceRecord,
  UniversalIdentity,
} from "../types/unified_identity_types";

// ── Base58 (Bitcoin alphabet) for did:key multibase encoding ────────────────
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const size = Math.ceil(((bytes.length - zeros) * 138) / 100) + 1;
  const b58 = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }
  let it = size - length;
  while (it < size && b58[it] === 0) it++;
  let result = "1".repeat(zeros);
  for (; it < size; it++) result += BASE58_ALPHABET[b58[it]];
  return result;
}

/** Build a `did:key` identifier from a raw ed25519 public key (32 bytes). */
function ed25519PublicKeyToDid(publicKeyRaw: Uint8Array): string {
  // multicodec prefix for ed25519-pub = 0xed 0x01
  const prefixed = new Uint8Array(publicKeyRaw.length + 2);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKeyRaw, 2);
  return `did:key:z${base58Encode(prefixed)}`;
}

/** Extract the 32-byte raw ed25519 public key from a DER SPKI buffer. */
function extractEd25519RawPublicKey(spkiDer: Buffer): Uint8Array {
  // The last 32 bytes of an ed25519 SPKI DER blob are the raw public key.
  return new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Event log helper ────────────────────────────────────────────────────────
async function recordEvent(
  did: string,
  type: IdentityEventType,
  description: string,
  payloadForHash: unknown,
  metadata?: Record<string, unknown>,
): Promise<IdentityEvent> {
  const event: IdentityEvent = {
    id: randomUUID(),
    type,
    did: did as IdentityEvent["did"],
    timestamp: nowIso(),
    description,
    dataHash: sha256Hex(JSON.stringify(payloadForHash)),
    triggeredBy: "system",
    metadata,
  };
  await db.insert(unifiedIdentityEvents).values({
    eventId: event.id,
    did: event.did,
    type: event.type,
    description: event.description,
    triggeredBy: String(event.triggeredBy),
    dataHash: event.dataHash,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
  });
  return event;
}

// ── Public API ──────────────────────────────────────────────────────────────

export const IdentityService = {
  /** Get the current (default) identity, or null if none exists. */
  async getCurrent(): Promise<UniversalIdentity | null> {
    const rows = await db
      .select()
      .from(unifiedIdentities)
      .where(eq(unifiedIdentities.isCurrent, true))
      .limit(1);
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].identityJson) as UniversalIdentity;
    } catch {
      return null;
    }
  },

  /** Create a new identity, set it as current, and emit `identity:created`. */
  async create(params: CreateIdentityParams): Promise<UniversalIdentity> {
    if (!params?.displayName?.trim()) {
      throw new Error("displayName is required");
    }
    if (!params?.walletAddress?.trim()) {
      throw new Error("walletAddress is required");
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const rawPublicKey = extractEd25519RawPublicKey(spkiDer);
    const publicKeyMultibase = `z${base58Encode(
      (() => {
        const prefixed = new Uint8Array(rawPublicKey.length + 2);
        prefixed[0] = 0xed;
        prefixed[1] = 0x01;
        prefixed.set(rawPublicKey, 2);
        return prefixed;
      })(),
    )}`;
    const did = ed25519PublicKeyToDid(rawPublicKey);
    const verificationMethodId = `${did}#${publicKeyMultibase.slice(1, 9)}`;
    const now = nowIso();

    const primaryWallet = {
      address: params.walletAddress,
      chain: params.chain,
      isPrimary: true,
      ownershipProof: {
        message: `I am ${did}`,
        signature: "",
        signedAt: now,
        verified: false,
      },
    } as UniversalIdentity["primaryWallet"];

    // Build a minimal-but-valid UniversalIdentity. Subsystem-specific fields
    // start empty and will be filled in by feature handlers (reputation,
    // social proofs, etc.).
    const identity: UniversalIdentity = {
      did: did as UniversalIdentity["did"],
      ensName: params.ensName,
      jnsName: params.registerJns ? `${params.registerJns}.joy` : undefined,
      primaryName:
        params.ensName ||
        (params.registerJns ? `${params.registerJns}.joy` : params.displayName),
      displayName: params.displayName,
      bio: params.bio,
      avatar: params.avatar,
      coverImage: params.coverImage,
      wallets: [primaryWallet],
      primaryWallet,
      keys: {
        signing: {
          id: verificationMethodId,
          algorithm: params.keyAlgorithm || "ed25519",
          publicKey: publicKeyMultibase,
          createdAt: now,
        },
        encryption: {
          id: `${did}#enc`,
          algorithm: "x25519",
          publicKey: publicKeyMultibase,
          createdAt: now,
        },
        delegation: [],
        recovery: [],
      } as unknown as UniversalIdentity["keys"],
      didDocument: {
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: did,
        verificationMethod: [
          {
            id: verificationMethodId,
            type: "Ed25519VerificationKey2020",
            controller: did,
            publicKeyMultibase,
          },
        ],
        authentication: [verificationMethodId],
        assertionMethod: [verificationMethodId],
        service: [],
      } as unknown as UniversalIdentity["didDocument"],
      socialProofs: [],
      domainVerifications: [],
      capabilities: [],
      roles: [],
      reputation: {
        overallScore: 0,
        trustLevel: "newcomer",
        totalTransactions: 0,
        components: [],
        badges: [],
        history: [],
        updatedAt: now,
      } as UniversalIdentity["reputation"],
      status: "online",
      lastSeen: now,
      verified: false,
      verificationLevel: "unverified" as UniversalIdentity["verificationLevel"],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    // Persist private key alongside identity (local-only; user controls disk).
    const privateKeyPem = privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string;
    const identityJson = JSON.stringify({
      ...identity,
      _privateKeyPem: privateKeyPem,
    });

    // Demote any existing current identity, then insert.
    await db
      .update(unifiedIdentities)
      .set({ isCurrent: false })
      .where(eq(unifiedIdentities.isCurrent, true));

    const ensRecords: NameServiceRecord[] = [];
    const jnsRecords: JNSRegistration[] = [];

    await db.insert(unifiedIdentities).values({
      did,
      isCurrent: true,
      identityJson,
      ensRecordsJson: JSON.stringify(ensRecords),
      jnsRecordsJson: JSON.stringify(jnsRecords),
    });

    await recordEvent(did, "identity:created", `Identity ${did} created`, {
      did,
      displayName: params.displayName,
    });

    return identity;
  },

  /** List ENS records associated with the current identity. */
  async listEns(): Promise<NameServiceRecord[]> {
    const rows = await db
      .select()
      .from(unifiedIdentities)
      .where(eq(unifiedIdentities.isCurrent, true))
      .limit(1);
    if (rows.length === 0) return [];
    try {
      return JSON.parse(rows[0].ensRecordsJson) as NameServiceRecord[];
    } catch {
      return [];
    }
  },

  /** List JNS (.joy) registrations for the current identity. */
  async listJns(): Promise<JNSRegistration[]> {
    const rows = await db
      .select()
      .from(unifiedIdentities)
      .where(eq(unifiedIdentities.isCurrent, true))
      .limit(1);
    if (rows.length === 0) return [];
    try {
      return JSON.parse(rows[0].jnsRecordsJson) as JNSRegistration[];
    } catch {
      return [];
    }
  },

  /** List recent identity events (newest first). */
  async listEvents(opts?: { limit?: number }): Promise<IdentityEvent[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
    const rows = await db
      .select()
      .from(unifiedIdentityEvents)
      .orderBy(unifiedIdentityEvents.id)
      .limit(limit);
    return rows
      .map((r) => {
        let metadata: Record<string, unknown> | undefined;
        if (r.metadataJson) {
          try {
            metadata = JSON.parse(r.metadataJson) as Record<string, unknown>;
          } catch {
            metadata = undefined;
          }
        }
        return {
          id: r.eventId,
          type: r.type as IdentityEventType,
          did: r.did as IdentityEvent["did"],
          timestamp: r.createdAt
            ? new Date(r.createdAt).toISOString()
            : nowIso(),
          description: r.description,
          dataHash: r.dataHash,
          triggeredBy:
            r.triggeredBy === "system"
              ? "system"
              : (r.triggeredBy as IdentityEvent["triggeredBy"]),
          metadata,
        } as IdentityEvent;
      })
      .reverse();
  },
};
