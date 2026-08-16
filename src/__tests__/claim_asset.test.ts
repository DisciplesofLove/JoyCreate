import { describe, expect, it } from "vitest";
import { ethers } from "ethers";

import { NATIVE_TOKEN_SENTINEL } from "@/config/joymarketplace";
import { buildClaimTransaction } from "@/lib/joymarketplace/claim_asset";

const buyer = "0x3e6d550a900808506955e11d687f76d9fff09377";
const usdc = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";

describe("buildClaimTransaction", () => {
  it("encodes a paid USDC claim without native value", () => {
    const transaction = buildClaimTransaction(buyer, {
      tokenId: "7",
      quantity: 2n,
      currency: usdc,
      pricePerToken: 1_500_000n,
    });
    expect(transaction.totalPrice).toBe(3_000_000n);
    expect(transaction.value).toBe(0n);
    expect(transaction.isNative).toBe(false);
    expect(transaction.data.slice(0, 10)).toBe(
      ethers.id("claim(address,uint256,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)").slice(0, 10),
    );
  });

  it("attaches native value for a native-currency claim", () => {
    const transaction = buildClaimTransaction(buyer, {
      tokenId: "8",
      quantity: 2n,
      currency: NATIVE_TOKEN_SENTINEL,
      pricePerToken: 10n,
    });
    expect(transaction.value).toBe(20n);
    expect(transaction.isNative).toBe(true);
  });
});