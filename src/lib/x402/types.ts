/**
 * X402 protocol types — the HTTP 402 challenge (`PaymentRequirements`) and the
 * `X-PAYMENT` payload carrying a signed EIP-3009 authorization.
 *
 * Shapes follow the x402 spec (scheme = "exact" over an EIP-3009 token).
 */

import type { X402Network } from "@/config/x402";

/**
 * The payment requirements a resource server returns in an HTTP 402 response.
 * The client uses these to construct a signed payment.
 */
export interface PaymentRequirements {
  /** Settlement scheme. Only "exact" (EIP-3009) is supported here. */
  scheme: "exact";
  /** Target network. */
  network: X402Network;
  /** Maximum amount required, in the asset's atomic base units (string). */
  maxAmountRequired: string;
  /** The resource being paid for (URL or logical id). */
  resource: string;
  /** Human-readable description of the charge. */
  description: string;
  /** MIME type of the protected resource, if applicable. */
  mimeType: string;
  /** Address the payment must be sent to (the RevenueSplitter). */
  payTo: string;
  /** How long (seconds) the server will wait for settlement. */
  maxTimeoutSeconds: number;
  /** The settlement asset (token contract address). */
  asset: string;
  /** EIP-712 domain data for the asset (name + version), used for signing. */
  extra?: {
    name: string;
    version: string;
  };
}

/** The EIP-3009 `transferWithAuthorization` parameters. */
export interface ExactEvmAuthorization {
  from: string;
  to: string;
  /** Atomic base units (string). */
  value: string;
  /** Unix seconds. */
  validAfter: string;
  /** Unix seconds. */
  validBefore: string;
  /** 32-byte hex nonce. */
  nonce: string;
}

/** The "exact" scheme payload: a signed EIP-3009 authorization. */
export interface ExactEvmPayload {
  /** 65-byte signature over the EIP-712 TransferWithAuthorization struct. */
  signature: string;
  authorization: ExactEvmAuthorization;
}

/** The decoded `X-PAYMENT` header value. */
export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: X402Network;
  payload: ExactEvmPayload;
}

/** Result of verifying a payment payload against its requirements. */
export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string;
  /** The recovered payer address when valid. */
  payer?: string;
}

/** Result of settling (submitting) a verified payment on-chain. */
export interface SettleResult {
  success: boolean;
  /** transferWithAuthorization tx hash. */
  txHash?: string;
  /** distribute() tx hash. */
  distributeTxHash?: string;
  payer?: string;
  /** Atomic amount settled. */
  amount?: string;
  /** 80/10/10 breakdown (atomic units). */
  split?: { creator: string; platform: string; protocol: string };
  error?: string;
}

/** The settlement response a facilitator returns (base64'd into a header). */
export interface SettlementResponse {
  success: boolean;
  txHash?: string;
  networkId?: string;
  payer?: string;
  error?: string;
}
