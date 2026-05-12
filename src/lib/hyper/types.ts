/**
 * Shared types for the Hypercore peer layer.
 */

export interface HyperPeerInfo {
  /** Hex-encoded remote public key. */
  publicKeyHex: string;
  /** Hex-encoded remote noise handshake hash. */
  remoteHostHex: string | null;
  /** Topics this peer is currently replicating with us. */
  topicsHex: string[];
  /** When we first observed this peer in this process. */
  firstSeenAt: number;
  /** When we last received bytes from them. */
  lastSeenAt: number;
}

export interface HyperTopicInfo {
  scope: string;
  subjectId: string;
  discoveryKeyHex: string;
  /** "log" | "bee" | "drive" | "autobase" — what this topic was opened as. */
  type: "log" | "bee" | "drive" | "autobase";
  /** Number of entries / records / files visible locally. */
  length: number;
  /** Hex of writable public key (this device's writer for the core). */
  writerKeyHex: string;
  /** Hex of root tree hash for the latest length (anchor checkpoint candidate). */
  treeHashHex: string | null;
  joinedAt: number;
}

export interface HyperServiceStatus {
  enabled: boolean;
  ready: boolean;
  /** Hex-encoded device-level public key derived from the corestore primary key. */
  deviceKeyHex: string | null;
  swarmConnections: number;
  topicsCount: number;
  rootDir: string | null;
  startedAt: number | null;
  /** Bound primary DID (did:joy:…) when SSI is provisioned. */
  ssiDid: string | null;
}

export interface HyperAppendResult {
  /** Sequence number of the appended block (1-indexed length). */
  seq: number;
  /** Hex hash of the appended block (used for tamper-evident verification). */
  hashHex: string;
  /** Discovery key for the topic the entry was appended to. */
  discoveryKeyHex: string;
}
