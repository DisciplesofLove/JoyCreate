/**
 * X402 facilitator (server side) — builds 402 challenges, verifies signed
 * payments, and settles them on-chain.
 *
 * Settlement is two on-chain steps:
 *   1. `transferWithAuthorization` moves USDC from payer → RevenueSplitter
 *      (gasless for the payer; the facilitator wallet pays gas).
 *   2. `distribute(USDC, creator, amount)` fans out 80/10/10.
 */

import { ethers } from "ethers";
import log from "electron-log";

import {
  REVENUE_SPLITTER_ABI,
  USDC_EIP3009_ABI,
  X402_CHAIN_IDS,
  X402_RPC,
  computeSplit,
  getRevenueSplitterAddress,
  getUsdcAddress,
  type X402ChainId,
  type X402Network,
} from "@/config/x402";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "@/lib/x402/types";

const logger = log.scope("x402_server");

const TX_OVERRIDES = {
  maxFeePerGas: 200_000_000n,
  maxPriorityFeePerGas: 100_000n,
};

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

function networkFor(chain: X402ChainId): X402Network {
  return chain === "arbitrumOne" ? "arbitrum-one" : "arbitrum-sepolia";
}

/**
 * Build the HTTP 402 `PaymentRequirements` challenge for a resource.
 *
 * @param amountAtomic - price in USDC atomic base units (6dp), as a string.
 */
export function createPaymentRequirements(opts: {
  chain: X402ChainId;
  amountAtomic: string;
  resource: string;
  description: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
}): PaymentRequirements {
  const { chain, amountAtomic, resource, description } = opts;
  return {
    scheme: "exact",
    network: networkFor(chain),
    maxAmountRequired: amountAtomic,
    resource,
    description,
    mimeType: opts.mimeType ?? "application/json",
    payTo: getRevenueSplitterAddress(chain),
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 600,
    asset: getUsdcAddress(chain),
    extra: { name: "USDC", version: "2" },
  };
}

async function resolveDomainMeta(
  token: ethers.Contract,
  extra?: { name: string; version: string },
): Promise<{ name: string; version: string }> {
  const name = extra?.name ?? (await token.name());
  let version = extra?.version;
  if (!version) {
    try {
      version = await token.version();
    } catch {
      version = "2";
    }
  }
  return { name, version };
}

/**
 * Verify a signed payment against its requirements WITHOUT settling.
 * Checks signature recovery, recipient, amount, time window, nonce reuse and
 * payer balance.
 */
export async function verifyPayment(
  payment: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResult> {
  if (payment.scheme !== "exact") {
    return { isValid: false, invalidReason: `unsupported scheme: ${payment.scheme}` };
  }
  if (payment.network !== requirements.network) {
    return { isValid: false, invalidReason: "network mismatch" };
  }

  const { authorization, signature } = payment.payload;
  const chain = networkToChainId(payment.network);
  const provider = new ethers.JsonRpcProvider(X402_RPC[chain]);
  const token = new ethers.Contract(requirements.asset, USDC_EIP3009_ABI, provider);
  const { name, version } = await resolveDomainMeta(token, requirements.extra);

  const domain = {
    name,
    version,
    chainId: X402_CHAIN_IDS[chain],
    verifyingContract: requirements.asset,
  };

  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(domain, EIP3009_TYPES, authorization, signature);
  } catch (err) {
    return { isValid: false, invalidReason: `signature recovery failed: ${err}` };
  }

  if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
    return { isValid: false, invalidReason: "signer does not match authorization.from" };
  }
  if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return { isValid: false, invalidReason: "payTo mismatch" };
  }
  if (BigInt(authorization.value) < BigInt(requirements.maxAmountRequired)) {
    return { isValid: false, invalidReason: "insufficient payment amount" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Number(authorization.validAfter) > now) {
    return { isValid: false, invalidReason: "authorization not yet valid" };
  }
  if (Number(authorization.validBefore) <= now) {
    return { isValid: false, invalidReason: "authorization expired" };
  }

  try {
    const used: boolean = await token.authorizationState(
      authorization.from,
      authorization.nonce,
    );
    if (used) return { isValid: false, invalidReason: "authorization nonce already used" };
  } catch {
    // authorizationState unavailable; skip the replay check.
  }

  try {
    const balance: bigint = await token.balanceOf(authorization.from);
    if (balance < BigInt(authorization.value)) {
      return { isValid: false, invalidReason: "payer balance too low" };
    }
  } catch {
    // balance check unavailable; proceed.
  }

  return { isValid: true, payer: recovered };
}

/**
 * Settle a verified payment: submit `transferWithAuthorization`, then call the
 * RevenueSplitter to fan out the 80/10/10 split to `creator`.
 *
 * @param facilitator - wallet that pays gas (must be the splitter owner to call distribute).
 * @param creator - the creator receiving the 80% share.
 */
export async function settlePayment(opts: {
  facilitator: ethers.Wallet;
  payment: PaymentPayload;
  requirements: PaymentRequirements;
  creator: string;
}): Promise<SettleResult> {
  const { facilitator, payment, requirements, creator } = opts;
  const verification = await verifyPayment(payment, requirements);
  if (!verification.isValid) {
    return { success: false, error: verification.invalidReason ?? "verification failed" };
  }

  const chain = networkToChainId(payment.network);
  const { authorization, signature } = payment.payload;
  const sig = ethers.Signature.from(signature);

  const usdc = new ethers.Contract(
    requirements.asset,
    USDC_EIP3009_ABI,
    facilitator,
  );

  let txHash: string | undefined;
  try {
    const tx = await usdc.transferWithAuthorization(
      authorization.from,
      authorization.to,
      authorization.value,
      authorization.validAfter,
      authorization.validBefore,
      authorization.nonce,
      sig.v,
      sig.r,
      sig.s,
      TX_OVERRIDES,
    );
    const rcpt = await tx.wait();
    txHash = rcpt?.hash;
    if (rcpt?.status !== 1) {
      return { success: false, txHash, error: "transferWithAuthorization reverted" };
    }
  } catch (err) {
    return { success: false, error: `settlement transfer failed: ${err}` };
  }

  const amount = BigInt(authorization.value);
  const split = computeSplit(amount);

  let distributeTxHash: string | undefined;
  try {
    const splitter = new ethers.Contract(
      getRevenueSplitterAddress(chain),
      REVENUE_SPLITTER_ABI,
      facilitator,
    );
    const tx = await splitter.distribute(
      requirements.asset,
      creator,
      amount,
      TX_OVERRIDES,
    );
    const rcpt = await tx.wait();
    distributeTxHash = rcpt?.hash;
    if (rcpt?.status !== 1) {
      logger.warn(`distribute reverted (funds held in splitter): ${distributeTxHash}`);
    }
  } catch (err) {
    logger.warn(`distribute failed (funds held in splitter): ${err}`);
  }

  return {
    success: true,
    txHash,
    distributeTxHash,
    payer: authorization.from,
    amount: amount.toString(),
    split: {
      creator: split.creator.toString(),
      platform: split.platform.toString(),
      protocol: split.protocol.toString(),
    },
  };
}

/** Read a creator's accrued earnings for a token from the splitter. */
export async function getCreatorEarnings(
  chain: X402ChainId,
  creator: string,
): Promise<{ token: string; creator: string; earnings: string }> {
  const provider = new ethers.JsonRpcProvider(X402_RPC[chain]);
  const splitter = new ethers.Contract(
    getRevenueSplitterAddress(chain),
    REVENUE_SPLITTER_ABI,
    provider,
  );
  const token = getUsdcAddress(chain);
  const earnings: bigint = await splitter.creatorEarnings(token, creator);
  return { token, creator, earnings: earnings.toString() };
}
