/**
 * X402 client — constructs and signs a payment for an HTTP 402 challenge.
 *
 * Implements the "exact" scheme over an EIP-3009 token (USDC): the payer signs
 * a `TransferWithAuthorization` EIP-712 struct off-chain (gasless for the
 * payer; the facilitator submits it). The signed authorization is packed into
 * the base64 `X-PAYMENT` header value.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  USDC_EIP3009_ABI,
  X402_CHAIN_IDS,
  X402_RPC,
  X402_VERSION,
  type X402ChainId,
  type X402Network,
} from "@/config/x402";
import type {
  ExactEvmAuthorization,
  PaymentPayload,
  PaymentRequirements,
} from "@/lib/x402/types";

const logger = log.scope("x402_client");

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function networkToChainId(network: X402Network): X402ChainId {
  return network === "arbitrum-one" ? "arbitrumOne" : "arbitrumSepolia";
}

/**
 * Resolve the EIP-712 domain (name + version) for the asset. Prefers the
 * values supplied in the requirements; otherwise reads them from the token.
 */
async function resolveDomainMeta(
  asset: string,
  chain: X402ChainId,
  extra?: { name: string; version: string },
): Promise<{ name: string; version: string }> {
  if (extra?.name && extra?.version) return extra;
  const provider = new ethers.JsonRpcProvider(X402_RPC[chain]);
  const token = new ethers.Contract(asset, USDC_EIP3009_ABI, provider);
  const name = extra?.name ?? (await token.name());
  let version = extra?.version;
  if (!version) {
    try {
      version = await token.version();
    } catch {
      version = "2"; // Circle USDC default
    }
  }
  return { name, version };
}

/**
 * Build and sign a payment for the given requirements. Returns the decoded
 * payload plus the base64 `X-PAYMENT` header value.
 */
export async function createPayment(
  wallet: ethers.Wallet,
  requirements: PaymentRequirements,
): Promise<{ payload: PaymentPayload; header: string }> {
  if (requirements.scheme !== "exact") {
    throw new Error(`unsupported x402 scheme: ${requirements.scheme}`);
  }
  const chain = networkToChainId(requirements.network);
  const chainId = X402_CHAIN_IDS[chain];
  const { name, version } = await resolveDomainMeta(
    requirements.asset,
    chain,
    requirements.extra,
  );

  const now = Math.floor(Date.now() / 1000);
  const validAfter = 0;
  const validBefore = now + Math.max(60, requirements.maxTimeoutSeconds || 600);
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const authorization: ExactEvmAuthorization = {
    from: wallet.address,
    to: requirements.payTo,
    value: requirements.maxAmountRequired,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  const domain = {
    name,
    version,
    chainId,
    verifyingContract: requirements.asset,
  };

  const signature = await wallet.signTypedData(domain, EIP3009_TYPES, {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce,
  });

  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: requirements.network,
    payload: { signature, authorization },
  };

  logger.info(
    `signed x402 payment: ${authorization.value} ${requirements.asset} -> ${requirements.payTo}`,
  );

  return { payload, header: encodePaymentHeader(payload) };
}

/** Base64-encode a payment payload for the `X-PAYMENT` header. */
export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Decode a base64 `X-PAYMENT` header value back into a payload. */
export function decodePaymentHeader(header: string): PaymentPayload {
  const json = Buffer.from(header, "base64").toString("utf8");
  return JSON.parse(json) as PaymentPayload;
}
