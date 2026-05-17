/**
 * Data Market — UI for the Arbitrum Stylus DataProvenance + DataLease
 * contracts.
 *
 *   1. Mint a Provenance Token (the "human stamp" + merkle root anchor).
 *   2. Create a Smart-Lease listing for a tokenId you own.
 *   3. Purchase a lease — backend records `LeaseGranted` for the Lit
 *      relayer to act on.
 *   4. View your minted tokens, your listings, and your held leases.
 *
 * All writes go through TanStack Query mutations in
 * `src/hooks/useDataMarket.ts`.
 */

import React, { useMemo, useState } from "react";
import { ethers } from "ethers";
import {
  useDataMarketStatus,
  useProvenanceTokens,
  useMintProvenance,
  useDataLeaseListings,
  useCreateLeaseListing,
  usePurchaseLease,
  useMyLeaseGrants,
} from "@/hooks/useDataMarket";
import type { DataMarketChainId } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SUPPORTED_CHAINS: { value: DataMarketChainId; label: string }[] = [
  { value: "arbitrumSepolia", label: "Arbitrum Sepolia (testnet)" },
  { value: "arbitrumOne", label: "Arbitrum One (mainnet)" },
];

function shortHash(value: string, head = 6, tail = 4): string {
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatEth(wei: string): string {
  try {
    return `${ethers.formatEther(BigInt(wei))} ETH`;
  } catch {
    return `${wei} wei`;
  }
}

function formatDuration(secs: string): string {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return secs;
  if (n >= 86400) return `${(n / 86400).toFixed(1)}d`;
  if (n >= 3600) return `${(n / 3600).toFixed(1)}h`;
  if (n >= 60) return `${(n / 60).toFixed(1)}m`;
  return `${n}s`;
}

function keccakUtf8(value: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DataMarketPage() {
  const [chain, setChain] = useState<DataMarketChainId>("arbitrumSepolia");
  const status = useDataMarketStatus(chain);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">Data Market</h1>
          <p className="text-muted-foreground">
            Mint Data Provenance Tokens on Arbitrum Stylus and lease them
            through smart-contract rules. No perpetual scraping — leases
            trigger time-bound Lit Protocol decryption keys to the lessee's
            secure training enclave.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Chain</CardTitle>
            <CardDescription>
              Select the deployment target. Writes use your active secp256k1
              key from the JCN key manager.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              {SUPPORTED_CHAINS.map((c) => (
                <Button
                  key={c.value}
                  variant={chain === c.value ? "default" : "outline"}
                  onClick={() => setChain(c.value)}
                  size="sm"
                >
                  {c.label}
                </Button>
              ))}
            </div>
            {status.data && (
              <div className="text-sm space-y-1 font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Provenance:</span>
                  <code>{status.data.provenanceAddress}</code>
                  {status.data.ready ? (
                    <Badge variant="default">live</Badge>
                  ) : (
                    <Badge variant="destructive">not deployed</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Lease:</span>
                  <code>{status.data.leaseAddress}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">RPC:</span>
                  <code>{status.data.rpcUrl}</code>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Tabs defaultValue="mint">
          <TabsList>
            <TabsTrigger value="mint">1. Mint Provenance</TabsTrigger>
            <TabsTrigger value="list">2. Create Listing</TabsTrigger>
            <TabsTrigger value="browse">3. Browse Listings</TabsTrigger>
            <TabsTrigger value="my-tokens">My Tokens</TabsTrigger>
            <TabsTrigger value="my-grants">My Leases</TabsTrigger>
          </TabsList>

          <TabsContent value="mint" className="pt-4">
            <MintProvenanceForm chain={chain} ready={status.data?.ready ?? false} />
          </TabsContent>
          <TabsContent value="list" className="pt-4">
            <CreateListingForm chain={chain} ready={status.data?.ready ?? false} />
          </TabsContent>
          <TabsContent value="browse" className="pt-4">
            <BrowseListings chain={chain} />
          </TabsContent>
          <TabsContent value="my-tokens" className="pt-4">
            <MyTokens chain={chain} />
          </TabsContent>
          <TabsContent value="my-grants" className="pt-4">
            <MyGrants chain={chain} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mint Provenance form
// ---------------------------------------------------------------------------

function MintProvenanceForm(props: { chain: DataMarketChainId; ready: boolean }) {
  const mint = useMintProvenance();
  const [contentUri, setContentUri] = useState("ipfs://");
  const [merkleRoot, setMerkleRoot] = useState("");
  const [humanProofSeed, setHumanProofSeed] = useState("");
  const [merkleSeed, setMerkleSeed] = useState("");

  const derivedMerkle = useMemo(
    () => (merkleSeed.trim() ? keccakUtf8(merkleSeed) : ""),
    [merkleSeed],
  );
  const derivedHumanProof = useMemo(
    () => (humanProofSeed.trim() ? keccakUtf8(humanProofSeed) : ethers.ZeroHash),
    [humanProofSeed],
  );

  const finalRoot = merkleRoot.trim() || derivedMerkle;

  const onMint = () => {
    if (!finalRoot) return;
    mint.mutate({
      chain: props.chain,
      merkleRoot: finalRoot,
      contentUri,
      humanProof: derivedHumanProof,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mint a Data Provenance Token</CardTitle>
        <CardDescription>
          Anchors the cryptographic Merkle root of your dataset on-chain,
          stamped with the personhood proof of the creator. Soulbound — the
          token never transfers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Content URI</Label>
          <Input
            value={contentUri}
            onChange={(e) => setContentUri(e.target.value)}
            placeholder="ipfs://bafy… or lit://…"
          />
        </div>
        <div className="space-y-2">
          <Label>Merkle root (0x-prefixed 32 bytes)</Label>
          <Input
            value={merkleRoot}
            onChange={(e) => setMerkleRoot(e.target.value)}
            placeholder="0x… (or derive below)"
          />
          <Input
            value={merkleSeed}
            onChange={(e) => setMerkleSeed(e.target.value)}
            placeholder="…or paste raw text to keccak256-derive"
          />
          {derivedMerkle && (
            <div className="text-xs text-muted-foreground font-mono">
              derived → {derivedMerkle}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label>Human-proof seed</Label>
          <Input
            value={humanProofSeed}
            onChange={(e) => setHumanProofSeed(e.target.value)}
            placeholder="any attestation string — gets keccak256'd"
          />
          <div className="text-xs text-muted-foreground font-mono">
            humanProof → {derivedHumanProof}
          </div>
        </div>
        <Button
          onClick={onMint}
          disabled={!props.ready || !finalRoot || !contentUri || mint.isPending}
        >
          {mint.isPending ? "Minting…" : "Mint Provenance Token"}
        </Button>
        {mint.data && (
          <div className="text-sm space-y-1">
            <div>
              tokenId: <code>#{mint.data.tokenId}</code>
            </div>
            <div>
              tx:{" "}
              <a
                href={`https://sepolia.arbiscan.io/tx/${mint.data.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {shortHash(mint.data.txHash)}
              </a>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Create listing form
// ---------------------------------------------------------------------------

function CreateListingForm(props: { chain: DataMarketChainId; ready: boolean }) {
  const create = useCreateLeaseListing();
  const [tokenId, setTokenId] = useState("");
  const [priceEth, setPriceEth] = useState("0.001");
  const [durationDays, setDurationDays] = useState("7");
  const [accConditions, setAccConditions] = useState("");

  const accHash = useMemo(
    () => (accConditions.trim() ? keccakUtf8(accConditions) : ""),
    [accConditions],
  );

  const onCreate = () => {
    if (!tokenId || !accHash) return;
    let priceWei: bigint;
    try {
      priceWei = ethers.parseEther(priceEth);
    } catch {
      return;
    }
    const durationSecs = BigInt(Math.floor(Number(durationDays) * 86400));
    create.mutate({
      chain: props.chain,
      tokenId,
      priceWei: priceWei.toString(),
      durationSecs: durationSecs.toString(),
      accConditionsHash: accHash,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a Smart-Lease Listing</CardTitle>
        <CardDescription>
          Sets the price + duration for a single lease and pins the Lit
          Protocol Access Control Conditions digest the relayer will use to
          provision decryption keys to the lessee.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Provenance token ID</Label>
          <Input
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value)}
            placeholder="e.g. 1"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Price (ETH)</Label>
            <Input
              value={priceEth}
              onChange={(e) => setPriceEth(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Duration (days)</Label>
            <Input
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Lit Protocol ACC (JSON or any seed)</Label>
          <Textarea
            value={accConditions}
            onChange={(e) => setAccConditions(e.target.value)}
            placeholder='[{"contractAddress":"0x…","chain":"arbitrumSepolia","method":"hasActiveLease",...}]'
            rows={4}
          />
          {accHash && (
            <div className="text-xs text-muted-foreground font-mono">
              accHash → {accHash}
            </div>
          )}
        </div>
        <Button
          onClick={onCreate}
          disabled={!props.ready || !tokenId || !accHash || create.isPending}
        >
          {create.isPending ? "Creating…" : "Create Listing"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Browse listings
// ---------------------------------------------------------------------------

function BrowseListings(props: { chain: DataMarketChainId }) {
  const listings = useDataLeaseListings({
    chain: props.chain,
    activeOnly: true,
  });
  const purchase = usePurchaseLease();

  if (listings.isLoading) return <div>Loading listings…</div>;
  if (listings.isError)
    return <div className="text-destructive">{listings.error.message}</div>;

  const rows = listings.data ?? [];
  if (rows.length === 0)
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No active listings yet. Create one from the previous tab.
        </CardContent>
      </Card>
    );

  return (
    <div className="grid gap-3">
      {rows.map((r) => (
        <Card key={r.id}>
          <CardContent className="py-4 flex items-center justify-between gap-3">
            <div className="space-y-1 text-sm">
              <div className="font-medium">
                Listing #{r.listingId} · Token #{r.tokenId}
              </div>
              <div className="text-muted-foreground font-mono">
                {shortHash(r.creator)} · {formatEth(r.priceWei)} ·{" "}
                {formatDuration(r.durationSecs)}
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                acc {shortHash(r.accConditionsHash, 10, 6)}
              </div>
            </div>
            <Button
              onClick={() =>
                purchase.mutate({
                  chain: props.chain,
                  listingId: r.listingId,
                  priceWei: r.priceWei,
                })
              }
              disabled={purchase.isPending}
            >
              {purchase.isPending ? "Purchasing…" : "Purchase lease"}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// My tokens
// ---------------------------------------------------------------------------

function MyTokens(props: { chain: DataMarketChainId }) {
  const tokens = useProvenanceTokens({ chain: props.chain });
  if (tokens.isLoading) return <div>Loading…</div>;
  const rows = tokens.data ?? [];
  if (rows.length === 0)
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No provenance tokens minted from this device yet.
        </CardContent>
      </Card>
    );
  return (
    <div className="grid gap-3">
      {rows.map((r) => (
        <Card key={r.id}>
          <CardContent className="py-4 text-sm space-y-1">
            <div className="flex items-center justify-between">
              <div className="font-medium">Token #{r.tokenId}</div>
              {r.revoked && <Badge variant="destructive">revoked</Badge>}
            </div>
            <div className="text-muted-foreground font-mono break-all">
              uri: {r.contentUri}
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              merkle {shortHash(r.merkleRoot, 10, 6)} · creator{" "}
              {shortHash(r.creator)} · tx {shortHash(r.txHash)}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// My grants (held leases)
// ---------------------------------------------------------------------------

function MyGrants(props: { chain: DataMarketChainId }) {
  const grants = useMyLeaseGrants({ chain: props.chain });
  if (grants.isLoading) return <div>Loading…</div>;
  const rows = grants.data ?? [];
  if (rows.length === 0)
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          You haven't purchased any leases yet.
        </CardContent>
      </Card>
    );
  const now = Math.floor(Date.now() / 1000);
  return (
    <div className="grid gap-3">
      {rows.map((r) => {
        const exp = Number(r.expiresAt);
        const active = Number.isFinite(exp) && exp > now;
        return (
          <Card key={r.id}>
            <CardContent className="py-4 text-sm space-y-1">
              <div className="flex items-center justify-between">
                <div className="font-medium">
                  Lease #{r.leaseId} · Token #{r.tokenId}
                </div>
                <Badge variant={active ? "default" : "outline"}>
                  {active ? "active" : "expired"}
                </Badge>
              </div>
              <div className="text-muted-foreground">
                paid {formatEth(r.paidWei)} · expires{" "}
                {new Date(exp * 1000).toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                relayer: {r.relayerStatus}
                {r.relayerError ? ` — ${r.relayerError}` : ""}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
