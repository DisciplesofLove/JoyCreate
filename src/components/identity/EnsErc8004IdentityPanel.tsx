/**
 * ENS + JNS + ERC-8004 Identity Panel.
 *
 * Consolidates the legacy DID/JNS "Unified Identity Hub". Identity is anchored
 * to two sibling name systems — ENS (`.eth`, via the standard ETH registrar)
 * and JNS (the Joy Name System, `.joy`) — plus on-chain ERC-8004 agent
 * registration, with reputation read from the on-chain ReputationRegistry. The
 * local off-chain reputation rollup remains a cache and is surfaced on the full
 * 8004scan explorer.
 */

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Fingerprint, Globe, ShieldCheck, ExternalLink, Search } from "lucide-react";

import {
  useErc8004Status,
  useErc8004ResolveByAddress,
  useErc8004Agent,
  useErc8004Reputation,
} from "@/hooks/useErc8004";
import { useJnsResolve } from "@/hooks/use_jns";
import type { Erc8004ChainId } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const SUPPORTED_CHAINS: { value: Erc8004ChainId; label: string }[] = [
  { value: "arbitrumSepolia", label: "Arbitrum Sepolia (testnet)" },
  { value: "arbitrumOne", label: "Arbitrum One (mainnet)" },
];

export function EnsErc8004IdentityPanel() {
  const [chain, setChain] = useState<Erc8004ChainId>("arbitrumSepolia");
  const [addressInput, setAddressInput] = useState("");
  const [resolvedAgentId, setResolvedAgentId] = useState<string | undefined>();

  const status = useErc8004Status(chain);
  const resolve = useErc8004ResolveByAddress(
    addressInput.trim() ? addressInput.trim() : undefined,
    chain,
  );
  const agent = useErc8004Agent(resolvedAgentId, chain);
  const reputation = useErc8004Reputation(resolvedAgentId, chain);

  const handleResolve = () => {
    if (!addressInput.trim()) return;
    void resolve.refetch().then((r) => {
      if (r.data?.agentId && r.data.agentId !== "0") {
        setResolvedAgentId(r.data.agentId);
      } else {
        setResolvedAgentId(undefined);
      }
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 space-y-4 max-w-3xl">
        {/* Intro */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Fingerprint className="w-5 h-5 text-violet-500" />
              <CardTitle>On-chain identity</CardTitle>
            </div>
            <CardDescription>
              Your identity is anchored to <strong>ENS</strong> names and an{" "}
              <strong>ERC-8004</strong> agent registration. Reputation is read
              from the on-chain ReputationRegistry.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-start gap-2">
              <Globe className="w-4 h-4 mt-0.5 text-blue-400 shrink-0" />
              <span>
                <strong>ENS</strong> — human-readable name and the root of your
                identity hierarchy.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <Globe className="w-4 h-4 mt-0.5 text-teal-400 shrink-0" />
              <span>
                <strong>JNS</strong> — the Joy Name System (<code>.joy</code>),
                the sibling of ENS for the JoyCreate namespace.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-4 h-4 mt-0.5 text-green-500 shrink-0" />
              <span>
                <strong>ERC-8004</strong> — trustless agent registry that ties
                your wallet to a verifiable on-chain reputation.
              </span>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Label htmlFor="identity-chain" className="text-xs">
                Network
              </Label>
              <select
                id="identity-chain"
                value={chain}
                onChange={(e) => {
                  setChain(e.target.value as Erc8004ChainId);
                  setResolvedAgentId(undefined);
                }}
                className="px-3 py-1.5 rounded-md border bg-background text-sm"
              >
                {SUPPORTED_CHAINS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <Badge variant={status.data?.ready ? "secondary" : "outline"}>
                {status.isLoading
                  ? "Checking…"
                  : status.data?.ready
                    ? "Registry ready"
                    : "Registry unavailable"}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Resolve identity from a wallet */}
        <Card>
          <CardHeader>
            <CardTitle>Find your agent identity</CardTitle>
            <CardDescription>
              Resolve your ERC-8004 agent id from a wallet address to view its
              on-chain record and reputation.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="identity-address">Wallet address</Label>
              <div className="flex gap-2">
                <Input
                  id="identity-address"
                  placeholder="0x…"
                  value={addressInput}
                  onChange={(e) => setAddressInput(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!addressInput.trim() || resolve.isFetching}
                  onClick={handleResolve}
                >
                  <Search className="w-4 h-4 mr-1" />
                  Resolve
                </Button>
              </div>
            </div>

            {resolve.isFetched && !resolvedAgentId && (
              <p className="text-sm text-muted-foreground">
                No ERC-8004 agent is registered for that address yet.
              </p>
            )}

            {agent.data && (
              <div className="rounded-lg border p-4 space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">#{agent.data.agentId}</Badge>
                  <span className="font-medium">
                    {agent.data.agentDomain || "—"}
                  </span>
                </div>
                <div className="font-mono text-muted-foreground break-all">
                  {agent.data.agentAddress}
                </div>
                {reputation.data && (
                  <div className="flex items-center gap-4 pt-2">
                    <span>
                      <span className="text-muted-foreground">Avg score:</span>{" "}
                      <strong>{reputation.data.average}</strong>
                    </span>
                    <span>
                      <span className="text-muted-foreground">
                        Feedback count:
                      </span>{" "}
                      {reputation.data.count}
                    </span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Resolve a JNS (.joy) name */}
        <JnsLookupCard />

        {/* Link to full explorer */}
        <Card>
          <CardContent className="flex items-center justify-between py-4">
            <div className="text-sm">
              <p className="font-medium">8004scan explorer</p>
              <p className="text-muted-foreground">
                Browse identities, reputation and validation across the agent
                economy.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link to="/8004scan">
                Open 8004scan
                <ExternalLink className="w-4 h-4 ml-1" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * JNS (.joy) name lookup — the sibling of ENS resolution. Reads owner, address,
 * and creator text records for a Joy Name System name via the `jns:resolve-name`
 * IPC channel. The chain is inferred from the name suffix.
 */
function JnsLookupCard() {
  const [nameInput, setNameInput] = useState("");
  const [queryName, setQueryName] = useState<string | undefined>();
  const jns = useJnsResolve(queryName);
  const result = jns.data;

  const handleLookup = () => {
    const trimmed = nameInput.trim();
    if (trimmed) setQueryName(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resolve a JNS (.joy) name</CardTitle>
        <CardDescription>
          Look up a Joy Name System name — the sibling of ENS. JNS resolves{" "}
          <code>.joy</code> names to a wallet address and creator records.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="jns-name">JNS name</Label>
          <div className="flex gap-2">
            <Input
              id="jns-name"
              placeholder="alice.joy"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleLookup();
              }}
            />
            <Button
              variant="outline"
              disabled={!nameInput.trim() || jns.isFetching}
              onClick={handleLookup}
            >
              <Search className="w-4 h-4 mr-1" />
              Resolve
            </Button>
          </div>
        </div>

        {jns.isError && (
          <p className="text-sm text-destructive">
            {(jns.error as Error)?.message ?? "Lookup failed."}
          </p>
        )}

        {result && !result.registered && (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{result.name}</span> is not registered
            yet.
          </p>
        )}

        {result?.registered && (
          <div className="rounded-lg border p-4 space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{result.chain}</Badge>
              <span className="font-medium font-mono">{result.name}</span>
            </div>
            {result.address && (
              <div>
                <span className="text-muted-foreground">Address:</span>{" "}
                <span className="font-mono break-all">{result.address}</span>
              </div>
            )}
            <div className="font-mono text-muted-foreground break-all">
              Owner: {result.owner}
            </div>
            {result.records.url && (
              <div>
                <span className="text-muted-foreground">URL:</span>{" "}
                {result.records.url}
              </div>
            )}
            {result.records.description && (
              <p className="text-muted-foreground">
                {result.records.description}
              </p>
            )}
            {result.records.storeName && (
              <div>
                <span className="text-muted-foreground">Store:</span>{" "}
                {result.records.storeName}
                {result.records.storeId ? ` (#${result.records.storeId})` : ""}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
