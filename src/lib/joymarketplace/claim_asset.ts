import { ethers } from "ethers";

import { ARB_SEPOLIA_ENS_CONTRACTS, NATIVE_TOKEN_SENTINEL } from "@/config/joymarketplace";
import { ARBITRUM_SEPOLIA } from "@/config/joymarketplace";
import { jcnKeyManager } from "@/lib/jcn_key_manager";
import { buildWallet } from "@/lib/joymarketplace/onchain_publisher";

const DROP_CLAIM_ABI = [
  "function claim(address receiver, uint256 tokenId, uint256 quantity, address currency, uint256 pricePerToken, (bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof, bytes data) payable",
] as const;

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

async function loadBuyerWallet(): Promise<ethers.Wallet> {
  await jcnKeyManager.initialize();
  const keys = await jcnKeyManager.listKeys("chain");
  const active = keys.find((key) => key.active && key.algorithm === "secp256k1");
  if (!active) {
    throw new Error("No active chain wallet configured. Import one in Settings first.");
  }
  const privateKey = await jcnKeyManager.getPrivateKey(active.keyId);
  if (!privateKey) throw new Error("Active chain wallet key is unavailable");
  return buildWallet(privateKey.toString("hex"), ARBITRUM_SEPOLIA);
}

export interface ClaimAssetInput {
  tokenId: string;
  quantity: bigint;
  currency: string;
  pricePerToken: bigint;
}

export interface ClaimAssetResult {
  tokenId: string;
  quantity: string;
  buyer: string;
  txHash: string;
  approvalTxHash?: string;
}

export function buildClaimTransaction(
  buyer: string,
  input: ClaimAssetInput,
): { data: string; value: bigint; totalPrice: bigint; isNative: boolean } {
  if (!ethers.isAddress(buyer)) throw new Error("buyer is invalid");
  if (!/^\d+$/.test(input.tokenId)) throw new Error("tokenId must be a decimal integer");
  if (input.quantity <= 0n) throw new Error("quantity must be positive");
  const currency = input.currency.toLowerCase();
  if (!ethers.isAddress(currency)) throw new Error("Indexed currency is invalid");
  const totalPrice = input.pricePerToken * input.quantity;
  const isNative = currency === NATIVE_TOKEN_SENTINEL.toLowerCase();
  const allowlistProof = {
    proof: [] as string[],
    quantityLimitPerWallet: 0n,
    pricePerToken: ethers.MaxUint256,
    currency: ethers.ZeroAddress,
  };
  const data = new ethers.Interface(DROP_CLAIM_ABI).encodeFunctionData("claim", [
    buyer,
    input.tokenId,
    input.quantity,
    currency,
    input.pricePerToken,
    allowlistProof,
    "0x",
  ]);
  return { data, value: isNative ? totalPrice : 0n, totalPrice, isNative };
}

export async function claimMarketplaceAsset(
  input: ClaimAssetInput,
): Promise<ClaimAssetResult> {
  const wallet = await loadBuyerWallet();
  const dropAddress = ARB_SEPOLIA_ENS_CONTRACTS.platformDrop;
  const currencyAddress = input.currency.toLowerCase();
  const { totalPrice, isNative } = buildClaimTransaction(wallet.address, input);
  let approvalTxHash: string | undefined;

  if (!isNative && totalPrice > 0n) {
    const currency = new ethers.Contract(currencyAddress, ERC20_ABI, wallet);
    const allowance = await currency.allowance(wallet.address, dropAddress) as bigint;
    if (allowance < totalPrice) {
      const approval = await currency.approve(dropAddress, totalPrice);
      const approvalReceipt = await approval.wait();
      if (!approvalReceipt) throw new Error("USDC approval receipt was unavailable");
      approvalTxHash = approvalReceipt.hash;
    }
  }

  const drop = new ethers.Contract(dropAddress, DROP_CLAIM_ABI, wallet);
  const allowlistProof = {
    proof: [] as string[],
    quantityLimitPerWallet: 0n,
    pricePerToken: ethers.MaxUint256,
    currency: ethers.ZeroAddress,
  };
  const claim = await drop.claim(
    wallet.address,
    input.tokenId,
    input.quantity,
    currencyAddress,
    input.pricePerToken,
    allowlistProof,
    "0x",
    { value: isNative ? totalPrice : 0n },
  );
  const receipt = await claim.wait();
  if (!receipt) throw new Error("Claim receipt was unavailable");

  return {
    tokenId: input.tokenId,
    quantity: input.quantity.toString(),
    buyer: wallet.address,
    txHash: receipt.hash,
    approvalTxHash,
  };
}