/**
 * JoyWallet — built-in Ethereum-compatible wallet for the Smart Browser.
 *
 * Goals:
 *   1. No browser-extension dependency (Electron has no MetaMask).
 *   2. Self-custodial — the private key never leaves the device.
 *   3. Optional password lock; encrypted at rest using AES-GCM via WebCrypto.
 *
 * Storage layout (localStorage, namespaced under `joywallet:`):
 *   joywallet:address      → 0x… (always plaintext for fast UI display)
 *   joywallet:keystore     → JSON { v, ciphertext, iv, salt, kdf }
 *
 * SECURITY NOTES
 *   • For "no-password" mode the keystore is encrypted with a static, app-bound
 *     passphrase. This protects against casual disk inspection but a determined
 *     attacker with read access to the JoyCreate install can recover the key.
 *     For real value, the user MUST set a password.
 *   • All key material is held in JS memory only while the wallet is unlocked.
 */

import { Wallet, JsonRpcProvider, formatEther } from "ethers";

const LS_ADDRESS = "joywallet:address";
const LS_KEYSTORE = "joywallet:keystore";
const APP_PASSPHRASE = "joycreate-joywallet-v1"; // static fallback, see notes above

// Default RPC — Polygon Amoy testnet (matches the rest of the app).
const DEFAULT_RPC = "https://rpc-amoy.polygon.technology";
const DEFAULT_CHAIN_ID = 80002;

interface Keystore {
  v: 1;
  ciphertextB64: string;
  ivB64: string;
  saltB64: string;
}

// ── crypto helpers ──────────────────────────────────────────────────────────

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPrivateKey(privateKey: string, passphrase: string): Promise<Keystore> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(privateKey),
  );
  return {
    v: 1,
    ciphertextB64: b64encode(new Uint8Array(ct)),
    ivB64: b64encode(iv),
    saltB64: b64encode(salt),
  };
}

async function decryptPrivateKey(ks: Keystore, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, b64decode(ks.saltB64));
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ks.ivB64) },
    key,
    b64decode(ks.ciphertextB64),
  );
  return new TextDecoder().decode(pt);
}

// ── public API ──────────────────────────────────────────────────────────────

export interface JoyWalletInfo {
  address: string;
  encrypted: boolean; // true if a user password is required to unlock
}

export function getStoredAddress(): string | null {
  try {
    return localStorage.getItem(LS_ADDRESS);
  } catch {
    return null;
  }
}

export function getStoredInfo(): JoyWalletInfo | null {
  const address = getStoredAddress();
  if (!address) return null;
  return { address, encrypted: hasUserPassword() };
}

/** Returns true if a user-set password (not the static fallback) is in use. */
export function hasUserPassword(): boolean {
  try {
    return localStorage.getItem("joywallet:hasUserPassword") === "1";
  } catch {
    return false;
  }
}

export async function createWallet(userPassword?: string): Promise<JoyWalletInfo> {
  const w = Wallet.createRandom();
  const passphrase = userPassword?.trim() ? userPassword.trim() : APP_PASSPHRASE;
  const ks = await encryptPrivateKey(w.privateKey, passphrase);
  localStorage.setItem(LS_ADDRESS, w.address);
  localStorage.setItem(LS_KEYSTORE, JSON.stringify(ks));
  if (userPassword?.trim()) localStorage.setItem("joywallet:hasUserPassword", "1");
  else localStorage.removeItem("joywallet:hasUserPassword");
  return { address: w.address, encrypted: !!userPassword?.trim() };
}

export async function importWallet(privateKey: string, userPassword?: string): Promise<JoyWalletInfo> {
  const w = new Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const passphrase = userPassword?.trim() ? userPassword.trim() : APP_PASSPHRASE;
  const ks = await encryptPrivateKey(w.privateKey, passphrase);
  localStorage.setItem(LS_ADDRESS, w.address);
  localStorage.setItem(LS_KEYSTORE, JSON.stringify(ks));
  if (userPassword?.trim()) localStorage.setItem("joywallet:hasUserPassword", "1");
  else localStorage.removeItem("joywallet:hasUserPassword");
  return { address: w.address, encrypted: !!userPassword?.trim() };
}

export async function unlockWallet(userPassword?: string): Promise<Wallet> {
  const raw = localStorage.getItem(LS_KEYSTORE);
  if (!raw) throw new Error("No JoyWallet found. Create or import one first.");
  const ks = JSON.parse(raw) as Keystore;
  const passphrase = userPassword?.trim() ? userPassword.trim() : APP_PASSPHRASE;
  let pk: string;
  try {
    pk = await decryptPrivateKey(ks, passphrase);
  } catch {
    throw new Error("Wrong password.");
  }
  return new Wallet(pk);
}

export async function exportPrivateKey(userPassword?: string): Promise<string> {
  const w = await unlockWallet(userPassword);
  return w.privateKey;
}

export function deleteWallet(): void {
  localStorage.removeItem(LS_ADDRESS);
  localStorage.removeItem(LS_KEYSTORE);
  localStorage.removeItem("joywallet:hasUserPassword");
}

export async function getBalance(rpcUrl = DEFAULT_RPC): Promise<{ wei: bigint; eth: string }> {
  const address = getStoredAddress();
  if (!address) throw new Error("No wallet");
  const provider = new JsonRpcProvider(rpcUrl, DEFAULT_CHAIN_ID);
  const wei = await provider.getBalance(address);
  return { wei, eth: formatEther(wei) };
}

export async function signMessage(message: string, userPassword?: string): Promise<string> {
  const w = await unlockWallet(userPassword);
  return w.signMessage(message);
}

export async function sendNative(
  to: string,
  amountEth: string,
  userPassword?: string,
  rpcUrl = DEFAULT_RPC,
): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl, DEFAULT_CHAIN_ID);
  const w = (await unlockWallet(userPassword)).connect(provider);
  const tx = await w.sendTransaction({
    to,
    value: BigInt(Math.round(Number(amountEth) * 1e18)),
  });
  return tx.hash;
}
